import AutoConsent, { type BackgroundMessage, type ConsentState, type ContentScriptMessage } from '@duckduckgo/autoconsent';
import browser from './browser';
import {
  collectControls,
  describeControls,
  dialogText,
  findConsentDialogs,
  hideDialog,
  isChecked,
  isDialogVisible,
  isForbidden,
  isVisible,
  kindOf,
  labelOf,
  navigates,
} from './dialog';
import { request } from './messaging';
import type { Control, Outcome } from './protocol';

const consent = new AutoConsent((message: ContentScriptMessage) => browser.runtime.sendMessage(message));
// Only our background script messages tabs, and only with autoconsent's messages.
browser.runtime.onMessage.addListener((message: unknown) => {
  consent.receiveMessageCallback(message as BackgroundMessage);
});

type Lifecycle = ConsentState['lifecycle'];
/** Autoconsent handled the banner. */
const RULES_SUCCEEDED: ReadonlySet<Lifecycle> = new Set(['optOutSucceeded', 'done']);
/** Autoconsent is working on a banner; wait for its result before stepping in. */
const RULES_BUSY: ReadonlySet<Lifecycle> = new Set(['openPopupDetected', 'runningOptOut']);

/** When and how long to look for a banner that autoconsent's rules did not handle. */
const FIRST_CHECK_MS = 2500;
const CHECK_EVERY_MS = 2500;
const GIVE_UP_MS = 15_000;
const MAX_ROUNDS = 3;
const MAX_WAITS = 6;
const SETTLE_MS = 1200;
/** Time for a settings view to re-render after a toggle changes. */
const TOGGLE_SETTLE_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const report = (outcome: Outcome) => request({ type: 'rc:outcome', outcome });

/**
 * The live element for a control the model saw: the original if it still has the same label and
 * kind, otherwise a re-rendered element that does. Pages can change while the model thinks.
 */
function live(dialog: HTMLElement, original: HTMLElement | undefined, control: Control): HTMLElement | undefined {
  const same = (el: HTMLElement) => el.isConnected && labelOf(el) === control.label && kindOf(el) === control.kind;
  if (original && same(original)) return original;
  return collectControls(dialog).find(same);
}

function safeToClick(el: HTMLElement, control: Control): boolean {
  if (control.forbidden || isForbidden(labelOf(el)) || navigates(el)) return false;
  return control.kind === 'toggle' || isVisible(el);
}

type Find = (control: Control) => HTMLElement | undefined;

/** Whether every toggle is present and off right now. */
function allOff(find: Find, toggles: Control[]): boolean {
  return toggles.every((control) => {
    const el = find(control);
    return el !== undefined && !isChecked(el);
  });
}

/** Switches the toggles off, then checks they all stayed off, since settings views re-render. */
async function switchOff(find: Find, toggles: Control[]): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const control of toggles) {
      const el = find(control);
      if (!el || !safeToClick(el, control)) return false;
      if (isChecked(el)) {
        el.click();
        await sleep(TOGGLE_SETTLE_MS);
      }
    }
    if (allOff(find, toggles)) return true;
  }
  return false;
}

type Step = 'notConsent' | 'wait' | 'done';

/**
 * Asks the on-device model what to do with the dialog, one step at a time, until it is gone.
 * Each step re-reads the page, because "Manage options" usually swaps in a new view, and acts only
 * on controls that still match what the model saw.
 */
async function negotiate(initial: HTMLElement): Promise<Step> {
  const clicked: string[] = [];
  let dialog = initial;
  const fail = async (error: string): Promise<Step> => {
    await report({ method: 'failed', error });
    return 'done';
  };

  for (let round = 0, waits = 0; round < MAX_ROUNDS; round++) {
    const elements = collectControls(dialog);
    const controls = describeControls(elements);
    const snapshot = { host: location.hostname, text: dialogText(dialog), controls, clicked };
    const result = await request({ type: 'rc:decide', dialog: snapshot });
    if ('wait' in result) {
      if (round === 0) return 'wait';
      // A rule took over mid-dialog; give it time, then look again from the same step.
      if (++waits > MAX_WAITS) return 'done';
      await sleep(CHECK_EVERY_MS);
      round--;
      continue;
    }
    if ('standDown' in result) return 'done';
    if ('error' in result) return fail(result.error);
    const { decision } = result;
    // A later view that is not about consent means the dialog is gone; the clicks are already reported.
    if (decision.kind === 'notConsent') return round === 0 ? 'notConsent' : 'done';
    if (decision.kind === 'noChoice') break;

    const target = controls[decision.target];
    if (!target) return fail('the model picked a control that does not exist');
    const find: Find = (control) => live(dialog, elements[control.index], control);
    const toggles = decision.turnOff.flatMap((index) => controls[index] ?? []);
    if (toggles.length > 0 && !(await switchOff(find, toggles))) {
      return fail('could not switch off every optional category');
    }
    // The target, if it still matches what the model saw and every toggle is still off.
    const ready = () => {
      const el = find(target);
      return el && safeToClick(el, target) && allOff(find, toggles) ? el : undefined;
    };
    if (!ready()) return fail(`would not click "${target.label}"`);
    clicked.push(target.label);
    // Saving consent often reloads the page, so report before clicking.
    await report({ method: 'model', clicked });
    const el = ready();
    if (!el) return fail(`"${target.label}" changed before the click`);
    el.click();

    await sleep(SETTLE_MS);
    const next = isDialogVisible(dialog) ? dialog : findConsentDialogs()[0];
    if (!next) return 'done';
    dialog = next;
  }

  // The model found no way to decline, or the dialog outlasted every step.
  hideDialog(dialog);
  await report({ method: 'hidden', clicked });
  return 'done';
}

/** The background answers autoconsent's init message with the per-site enabled flag. */
function initializedAndEnabled(): boolean {
  try {
    return consent.config.enabled;
  } catch {
    return false;
  }
}

/**
 * Waits for autoconsent, then hands the first consent dialog it left on screen to the model.
 * Dialogs the model calls something else are skipped, so the next one still gets a turn.
 */
async function fallbackToModel() {
  const notConsent = new Set<HTMLElement>();
  const deadline = Date.now() + FIRST_CHECK_MS + GIVE_UP_MS;
  await sleep(FIRST_CHECK_MS);
  for (; Date.now() < deadline; await sleep(CHECK_EVERY_MS)) {
    if (!initializedAndEnabled() || RULES_BUSY.has(consent.state.lifecycle)) continue;
    if (RULES_SUCCEEDED.has(consent.state.lifecycle)) return;
    const dialog = findConsentDialogs().find((d) => !notConsent.has(d));
    if (!dialog) continue;
    const step = await negotiate(dialog);
    if (step === 'done') return;
    if (step === 'notConsent') notConsent.add(dialog);
  }
}

fallbackToModel().catch((error: unknown) => report({ method: 'failed', error: String(error) }));
