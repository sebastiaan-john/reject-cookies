import {
  evalSnippets,
  filterCompactRules,
  type CompactCMPRuleset,
  type ContentScriptMessage,
  type IndexedCMPRuleset,
} from '@duckduckgo/autoconsent';
import compactRules from '@duckduckgo/autoconsent/rules/compact-rules.json';
import type { Runtime } from 'webextension-polyfill';
import browser from './browser';
import { AUTOCONSENT_CONFIG } from './config';
import type {
  DecideResult,
  Decision,
  DialogSnapshot,
  ExtensionRequest,
  ModelAvailability,
  NativeRequest,
  Outcome,
  PopupState,
} from './protocol';

const NATIVE_APP_ID = 'ai.sebastiaan.RejectCookies';
const rules = compactRules as unknown as IndexedCMPRuleset;
const hostOf = (url: string) => URL.parse(url)?.hostname ?? '';

// Per-site switch: one storage key per disabled host.

const disabledKey = (host: string) => `disabled:${host}`;

async function isEnabled(host: string) {
  return !(await browser.storage.local.get(disabledKey(host)))[disabledKey(host)];
}

async function setSiteEnabled(host: string, enabled: boolean) {
  if (enabled) await browser.storage.local.remove(disabledKey(host));
  else await browser.storage.local.set({ [disabledKey(host)]: true });
}

// Per-tab state. Autoconsent runs in every frame, so the background is the one place that knows
// whether a rule anywhere in the tab is handling the banner.

type TabState = {
  /** Frames where an autoconsent rule found a popup and has not reported its opt-out result yet. */
  busyFrames: Set<number>;
  rulesDone: boolean;
  /** Model decisions left for this page, so a page cannot flood the model. */
  decisionsLeft: number;
};

const MAX_DECISIONS_PER_PAGE = 8;
const tabs = new Map<number, TabState>();

function tabState(tabId: number): TabState {
  let state = tabs.get(tabId);
  if (!state) {
    state = { busyFrames: new Set(), rulesDone: false, decisionsLeft: MAX_DECISIONS_PER_PAGE };
    tabs.set(tabId, state);
  }
  return state;
}

const outcomeKey = (tabId: number) => `outcome-${tabId}`;

/** The last outcome in a tab, with the host it happened on. */
type TabOutcome = { host: string; outcome: Outcome };

async function tabOutcome(tabId: number): Promise<TabOutcome | undefined> {
  return (await browser.storage.session.get(outcomeKey(tabId)))[outcomeKey(tabId)] as TabOutcome | undefined;
}

async function recordOutcome(tabId: number, host: string, outcome: Outcome) {
  await browser.storage.session.set({ [outcomeKey(tabId)]: { host, outcome } satisfies TabOutcome });
  await browser.action.setBadgeText({ tabId, text: outcome.method === 'failed' ? '' : '✓' });
}

/** Consent often reloads the page, so an outcome only expires when the tab moves to another site. */
async function expireOutcome(tabId: number, host: string) {
  if ((await tabOutcome(tabId))?.host === host) return;
  await browser.storage.session.remove(outcomeKey(tabId));
  await browser.action.setBadgeText({ tabId, text: '' });
}

// The on-device model, behind the native app extension.

let nativeQueue: Promise<unknown> = Promise.resolve();

function native(request: NativeRequest): Promise<unknown> {
  return browser.runtime.sendNativeMessage(NATIVE_APP_ID, request);
}

/** One model request at a time: the model runs one inference at a time anyway. */
function serially<T>(work: () => Promise<T>): Promise<T> {
  const result = nativeQueue.then(work);
  nativeQueue = result.catch(() => undefined);
  return result;
}

const DECISION_KINDS: ReadonlySet<string> = new Set(['decline', 'customize', 'save', 'noChoice', 'notConsent']);

function parseDecision(value: unknown): Decision | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, target, turnOff } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || !DECISION_KINDS.has(kind) || typeof target !== 'number') return undefined;
  if (!Array.isArray(turnOff) || !turnOff.every((i) => typeof i === 'number')) return undefined;
  return { kind: kind as Decision['kind'], target, turnOff };
}

/** Native replies are `{ ok: true, decision }`, `{ ok: true, availability }`, or `{ ok: false, error }`. */
function nativeError(response: unknown): string {
  const error = (response as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' ? error : 'unexpected reply from the native extension';
}

/** Dialogs the model said were not consent requests, per site, so each is asked about once. */
const MAX_NOT_CONSENT = 500;

async function dialogKey(host: string, dialog: DialogSnapshot): Promise<string> {
  const source = new TextEncoder().encode(JSON.stringify([dialog.text, dialog.controls.map((c) => c.label)]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  return `${host} ${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function notConsentKeys(): Promise<string[]> {
  const value = (await browser.storage.local.get('notConsent')).notConsent;
  return Array.isArray(value) ? value : [];
}

let cacheWrites: Promise<unknown> = Promise.resolve();

/** Read-modify-write behind one chain, so concurrent tabs do not drop each other's keys. */
function rememberNotConsent(key: string) {
  cacheWrites = cacheWrites
    .then(async () => {
      const known = await notConsentKeys();
      if (!known.includes(key)) await browser.storage.local.set({ notConsent: [...known, key].slice(-MAX_NOT_CONSENT) });
    })
    .catch(() => undefined);
  return cacheWrites;
}

/** Whether the model may act on this page right now. Checked before and after inference. */
async function standing(tabId: number, tab: TabState, siteHost: string): Promise<DecideResult | undefined> {
  const enabled = await isEnabled(siteHost);
  // Checked after the await, so a rule finishing or a navigation during the read still counts.
  if (!enabled || tabs.get(tabId) !== tab || tab.rulesDone) return { standDown: true };
  if (tab.busyFrames.size > 0) return { wait: true };
  return undefined;
}

async function decide(tabId: number, siteHost: string, dialog: DialogSnapshot): Promise<DecideResult> {
  const tab = tabState(tabId);
  const before = await standing(tabId, tab, siteHost);
  if (before) return before;

  const key = await dialogKey(siteHost, dialog);
  if ((await notConsentKeys()).includes(key)) return { decision: { kind: 'notConsent', target: -1, turnOff: [] } };
  if (tab.decisionsLeft <= 0) return { error: 'too many dialogs on this page' };
  tab.decisionsLeft--;

  const response = await serially(async () => {
    // The page may have moved on, or a rule may have started, while this request queued.
    const queued = await standing(tabId, tab, siteHost);
    return queued ?? native({ type: 'decide', dialog });
  }).catch((error: unknown) => ({ error: String(error) }));
  if (typeof response === 'object' && response !== null && ('wait' in response || 'standDown' in response)) {
    return response as DecideResult;
  }
  const decision = parseDecision((response as { decision?: unknown } | undefined)?.decision);
  if (!decision) return { error: nativeError(response) };
  if (decision.kind === 'notConsent') await rememberNotConsent(key);
  return (await standing(tabId, tab, siteHost)) ?? { decision };
}

async function modelAvailability(): Promise<ModelAvailability> {
  const response = await native({ type: 'availability' }).catch((error: unknown) => ({ error: String(error) }));
  const availability = (response as { availability?: { available?: unknown; reason?: unknown } } | undefined)?.availability;
  if (typeof availability?.available !== 'boolean') return { available: false, reason: nativeError(response) };
  const reason = typeof availability.reason === 'string' ? availability.reason : undefined;
  return { available: availability.available, ...(reason && { reason }) };
}

async function popupState(tabId: number, host: string): Promise<PopupState> {
  const stored = await tabOutcome(tabId);
  const outcome = stored?.host === host ? stored.outcome : null;
  return { enabled: await isEnabled(host), outcome, model: await modelAvailability() };
}

// Autoconsent's messages.

/** Runs one of autoconsent's named snippets in the page's own JavaScript world. */
async function evalInPage(tabId: number, frameId: number, snippetId: keyof typeof evalSnippets | undefined) {
  if (!snippetId || !(snippetId in evalSnippets)) return false;
  const [injection] = await browser.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: evalSnippets[snippetId],
  });
  return injection?.result ?? false;
}

/** `url` is the sending frame's; per-site settings and outcomes use the tab's top-level host. */
async function handleAutoconsent(message: ContentScriptMessage, tabId: number, frameId: number, url: string, tabHost: string) {
  switch (message.type) {
    case 'init': {
      // During navigation the tab may still report the previous URL, so the main frame uses its own.
      const siteHost = frameId === 0 ? hostOf(url) : tabHost;
      if (frameId === 0) {
        tabs.delete(tabId);
        await expireOutcome(tabId, siteHost);
      } else {
        // A frame's new document drops whatever its previous one was doing.
        tabState(tabId).busyFrames.delete(frameId);
      }
      const compact = filterCompactRules(rules, { url, mainFrame: frameId === 0 }) as CompactCMPRuleset;
      const config = { ...AUTOCONSENT_CONFIG, enabled: await isEnabled(siteHost) };
      await browser.tabs.sendMessage(tabId, { type: 'initResp', rules: { autoconsent: [], compact }, config }, { frameId });
      break;
    }
    case 'eval': {
      const result = await evalInPage(tabId, frameId, message.snippetId).catch(() => false);
      await browser.tabs.sendMessage(tabId, { type: 'evalResp', id: message.id, result }, { frameId });
      break;
    }
    // Autoconsent reports every popup it finds but runs one rule per frame, ending with optOutResult.
    case 'popupFound':
      tabState(tabId).busyFrames.add(frameId);
      break;
    case 'optOutResult':
      tabState(tabId).busyFrames.delete(frameId);
      break;
    case 'autoconsentDone':
      tabState(tabId).rulesDone = true;
      await recordOutcome(tabId, tabHost, { method: 'rule', cmp: message.cmp, cosmetic: message.isCosmetic });
      break;
    case 'autoconsentError':
      console.warn('autoconsent error', message.details);
      break;
  }
}

function handleRequest(request: ExtensionRequest, sender: Runtime.MessageSender): Promise<unknown> | undefined {
  const tabId = sender.tab?.id;
  const tabHost = hostOf(sender.tab?.url ?? sender.url ?? '');
  switch (request.type) {
    case 'rc:decide':
      return tabId === undefined ? undefined : decide(tabId, tabHost, request.dialog);
    case 'rc:outcome':
      return tabId === undefined ? undefined : recordOutcome(tabId, tabHost, request.outcome);
    case 'rc:popupState':
      return popupState(request.tabId, request.host);
    case 'rc:setSiteEnabled':
      return setSiteEnabled(request.host, request.enabled);
  }
}

function isExtensionRequest(message: unknown): message is ExtensionRequest {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === 'string' && type.startsWith('rc:');
}

browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
  if (isExtensionRequest(message)) return handleRequest(message, sender);
  const tabId = sender.tab?.id;
  const type = (message as { type?: unknown } | null)?.type;
  if (tabId === undefined || typeof type !== 'string') return;
  const url = sender.url ?? sender.tab?.url ?? '';
  const tabHost = hostOf(sender.tab?.url ?? url);
  handleAutoconsent(message as ContentScriptMessage, tabId, sender.frameId ?? 0, url, tabHost).catch((error: unknown) =>
    console.warn('autoconsent message failed', type, error),
  );
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  return browser.storage.session.remove(outcomeKey(tabId));
});
