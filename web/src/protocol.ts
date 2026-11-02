/** One interactive element inside a consent dialog, as the model sees it. */
export type Control = {
  index: number;
  kind: 'button' | 'link' | 'toggle';
  label: string;
  /** Only set for toggles. */
  checked?: boolean;
  /** Autoconsent's multilingual regex reading of a button label, when it recognises one. */
  hint?: 'reject' | 'accept' | 'settings' | 'acknowledge';
  /** Accepts everything, or is a paywall or login button. Never clicked. */
  forbidden?: true;
};

/** A compact, model-sized description of a visible consent dialog. Mirrors `DialogSnapshot` in Swift. */
export type DialogSnapshot = {
  host: string;
  text: string;
  controls: Control[];
  /** Labels already clicked in this dialog, oldest first. */
  clicked: string[];
};

/**
 * What to do with a dialog. Mirrors `ConsentDecision` in Shared/ConsentDecider.swift.
 * - decline: click `target` to reject or keep only necessary cookies.
 * - customize: click `target` to open the settings view, then decide again.
 * - save: turn off `turnOff` toggles, then click `target` to save.
 * - noChoice: the dialog offers no way to decline; hide it.
 * - notConsent: this is not a cookie consent dialog.
 */
export type Decision = {
  kind: 'decline' | 'customize' | 'save' | 'noChoice' | 'notConsent';
  target: number;
  turnOff: number[];
};

/**
 * The background's answer to `rc:decide`. `wait`: a rule in some frame is working on a banner, so
 * ask again later. `standDown`: a rule handled the banner, the site is off, or the page changed.
 */
export type DecideResult = { decision: Decision } | { wait: true } | { standDown: true } | { error: string };

/** How a page's banner was dealt with, shown in the popup. */
export type Outcome =
  | { method: 'rule'; cmp: string; cosmetic: boolean }
  | { method: 'model'; clicked: string[] }
  | { method: 'hidden'; clicked: string[] }
  | { method: 'failed'; error: string };

export type ModelAvailability = { available: boolean; reason?: string };

export type PopupState = {
  enabled: boolean;
  outcome: Outcome | null;
  model: ModelAvailability;
};

/** Messages our content script and popup send to the background, next to autoconsent's own. */
export type ExtensionRequest =
  | { type: 'rc:decide'; dialog: DialogSnapshot }
  | { type: 'rc:outcome'; outcome: Outcome }
  | { type: 'rc:popupState'; tabId: number; host: string }
  | { type: 'rc:setSiteEnabled'; host: string; enabled: boolean };

/** The background's reply to each request. */
export type ResponseTo<R extends ExtensionRequest> = R extends { type: 'rc:decide' }
  ? DecideResult
  : R extends { type: 'rc:popupState' }
    ? PopupState
    : void;

/** Messages to the native handler (Extension/SafariWebExtensionHandler.swift). */
export type NativeRequest = { type: 'decide'; dialog: DialogSnapshot } | { type: 'availability' };
