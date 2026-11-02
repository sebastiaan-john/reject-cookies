/**
 * Runs the built content script against real websites in Playwright's WebKit, with the background
 * script's autoconsent wiring reproduced here and the real on-device model behind `rc:decide`.
 * For each site it saves a screenshot without the extension and one with it, and prints what happened.
 *
 * Exits non-zero when a site errors or the extension reports a failure; read the screenshots for the rest.
 *
 * Usage: bun run e2e [--model-only] [url ...]    (defaults to scripts/sites.txt)
 * --model-only switches off autoconsent's rules, built-in ones included, so every banner goes to the model.
 * Needs `bun run build` and the decide tool: swiftc -O -swift-version 6 -o .build/decide Shared/ConsentDecider.swift Tools/decide/main.swift
 */
import { evalSnippets, filterCompactRules, type ContentScriptMessage, type IndexedCMPRuleset } from '@duckduckgo/autoconsent';
import compactRules from '@duckduckgo/autoconsent/rules/compact-rules.json';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { webkit, type Browser, type Frame } from 'playwright';
import { AUTOCONSENT_CONFIG } from '../src/config';
import type { DecideResult, Decision, DialogSnapshot, ExtensionRequest, Outcome } from '../src/protocol';

const root = new URL('../../', import.meta.url).pathname;
const SETTLE_MS = 30_000;
const STABLE_MS = 6000;
const args = process.argv.slice(2);
const modelOnly = args.includes('--model-only');
const outDir = `${root}.build/e2e${modelOnly ? '-model' : ''}`;

const decider = spawn(`${root}.build/decide`, { stdio: ['pipe', 'pipe', 'inherit'] });
const pending: ((line: string) => void)[] = [];
const exited = JSON.stringify({ error: 'decide tool exited' });
let deciderClosed = false;
const closeDecider = () => {
  deciderClosed = true;
  pending.splice(0).forEach((resolve) => resolve(exited));
};
createInterface({ input: decider.stdout! })
  .on('line', (line) => pending.shift()?.(line))
  .on('close', closeDecider);
decider.on('error', closeDecider);
let queue = Promise.resolve();

type DecideReply = { decision: Decision; ms: number } | { error: string };

/** The decide tool answers one line at a time, so requests are serialised. */
function decide(dialog: DialogSnapshot): Promise<DecideReply> {
  const result = queue.then(
    () =>
      new Promise<string>((resolve) => {
        if (deciderClosed) return resolve(exited);
        pending.push(resolve);
        decider.stdin!.write(`${JSON.stringify(dialog)}\n`);
      }),
  );
  queue = result.then(() => undefined);
  return result.then((line) => JSON.parse(line) as DecideReply);
}

/** Built-in autoconsent rules that ship as code, so `--model-only` has to switch them off by name. */
const BUILT_IN_CMPS = [
  'Admiral', 'consentmanager.net', 'Conversant', 'Cybotcookiebot', 'Evidon', 'Klaro', 'Onetrust',
  'Sourcepoint-frame', 'tiktok.com', 'TrustArc-top', 'Uniconsent',
];

const shim = `(() => {
  const listeners = [];
  globalThis.browser = {
    runtime: {
      sendMessage: (message) => window.__rcSend(message),
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  globalThis.__rcDeliver = (message) => listeners.forEach((fn) => fn(message));
})();`;

type SiteResult = { url: string; outcome: Outcome | null; lifecycle?: string; decisions: unknown[]; error?: string };

async function deliver(frame: Frame, message: unknown) {
  const deliverInPage = (m: unknown) => (globalThis as unknown as { __rcDeliver: (m: unknown) => void }).__rcDeliver(m);
  await frame.evaluate(deliverInPage, message).catch(() => {});
}

async function runSite(browser: Browser, url: string, slug: string): Promise<SiteResult> {
  const result: SiteResult = { url, outcome: null, decisions: [] };
  let decisionsInFlight = 0;
  // The same rule as background.ts: no model while a rule in any frame is working, or once one succeeded.
  let busyFrames = new Set<Frame>();
  let rulesDone = false;

  const baseline = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'nl-NL' });
  try {
    await baseline.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await baseline.waitForTimeout(5000);
    await baseline.screenshot({ path: `${outDir}/${slug}-before.png` });
  } catch (error) {
    result.error = `baseline: ${error}`;
  }
  await baseline.close();

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'nl-NL' });
  const content = await readFile(`${root}Extension/Resources/content.js`, 'utf8');
  await context.exposeBinding('__rcSend', async ({ frame }, raw: unknown): Promise<DecideResult | void> => {
    const message = raw as ContentScriptMessage | ExtensionRequest;
    switch (message.type) {
      case 'init': {
        const mainFrame = frame === frame.page().mainFrame();
        if (mainFrame) [busyFrames, rulesDone] = [new Set(), false];
        else busyFrames.delete(frame);
        const compact = filterCompactRules(compactRules as unknown as IndexedCMPRuleset, { url: frame.url(), mainFrame });
        const rules = modelOnly ? { autoconsent: [] } : { autoconsent: [], compact };
        const modelOnlyConfig = { heuristicMode: 'off', detectRetries: 1, disabledCmps: BUILT_IN_CMPS } as const;
        const config = { ...AUTOCONSENT_CONFIG, enabled: true, ...(modelOnly && modelOnlyConfig) };
        setTimeout(() => deliver(frame, { type: 'initResp', rules, config }));
        return;
      }
      case 'eval': {
        const snippet = evalSnippets[message.snippetId as keyof typeof evalSnippets];
        const value = snippet ? await frame.evaluate(snippet).catch(() => false) : false;
        setTimeout(() => deliver(frame, { type: 'evalResp', id: message.id, result: value }));
        return;
      }
      case 'report':
        if (message.mainFrame) result.lifecycle = `${message.state.lifecycle} ${message.state.detectedCmps.join(',')}`;
        return;
      case 'popupFound':
        busyFrames.add(frame);
        return;
      case 'optOutResult':
        busyFrames.delete(frame);
        return;
      case 'autoconsentDone':
        rulesDone = true;
        result.outcome = { method: 'rule', cmp: message.cmp, cosmetic: message.isCosmetic };
        return;
      case 'rc:decide': {
        if (rulesDone) return { standDown: true };
        if (busyFrames.size > 0) return { wait: true };
        decisionsInFlight++;
        const reply = await decide(message.dialog).finally(() => decisionsInFlight--);
        result.decisions.push({ dialog: message.dialog, reply });
        return 'error' in reply ? { error: reply.error } : { decision: reply.decision };
      }
      case 'rc:outcome':
        result.outcome = message.outcome;
        return;
    }
  });
  await context.addInitScript(shim);
  await context.addInitScript(content);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Multi-step dialogs report after each click, so wait until the outcome stops changing.
    const deadline = Date.now() + SETTLE_MS;
    let last = '';
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const current = JSON.stringify(result.outcome);
      if (current !== last || decisionsInFlight > 0) [last, stableSince] = [current, Date.now()];
      else if (result.outcome && Date.now() - stableSince > STABLE_MS) break;
    }
    if (decisionsInFlight > 0) result.error = 'model still deciding at the deadline';
    await page.screenshot({ path: `${outDir}/${slug}-after.png` });
  } catch (error) {
    result.error = `${result.error ?? ''} extension: ${error}`;
  }
  await context.close();
  return result;
}

const urlArgs = args.filter((arg) => !arg.startsWith('--'));
const urls = urlArgs.length
  ? urlArgs
  : (await readFile(new URL('./sites.txt', import.meta.url), 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

await mkdir(outDir, { recursive: true });
const browser = await webkit.launch();
const results: SiteResult[] = [];
const CONCURRENCY = 4;
const queueUrls = urls.map((url, i) => ({ url, slug: `${String(i).padStart(2, '0')}-${new URL(url).hostname.replace(/^www\./, '')}` }));
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queueUrls.shift(); next; next = queueUrls.shift()) {
      const result = await runSite(browser, next.url, next.slug);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }),
);
await browser.close();
decider.stdin!.end();
await writeFile(`${outDir}/results.json`, JSON.stringify(results, null, 2));
const broken = results.filter((r) => r.error || r.outcome?.method === 'failed');
if (broken.length > 0) {
  console.error(`${broken.length} site(s) failed: ${broken.map((r) => r.url).join(', ')}`);
  process.exit(1);
}
