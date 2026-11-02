import { classifyButtonTextRegex } from '@duckduckgo/autoconsent/heuristics';
import type { Control } from './protocol';

const CONSENT_TEXT =
  /cookie|consent|gdpr|tracking technolog|privacy|privacidad|datenschutz|confidentialit|einwilligung|toestemming|samtycke|consentement|consenso|consentimiento|zgod[ay]|souhlas/i;

/** Paywall, subscription, and login buttons. Never a consent choice, whatever the model says. */
const PAYWALL = /subscri|abonn|\babo\b|sign.?in|log.?in|anmeld|inlog|connecter|\bpay|bezahl|kaufen|\bbuy\b|purchase/i;

/** Autoconsent's regexes read "Save choices" or "Auswahl speichern" as accepting; these save a selection. */
const SAVES_SELECTION =
  /save|confirm|selec|choice|keuze|opslaan|speicher|auswahl|bestätig|enregistr|guardar|salva|preferen|voorkeur|einstellung/i;
/** Accept-everything wording, whether or not autoconsent's classifier recognises the label. */
const ACCEPT_WORD = '(accept|allow|agree|akzept|accepte|acepta|accett|accepteer|toestaan|godkänn)\\w*';
const ALL_WORD = '(all|alle|alles|tout|tous|toutes|todo|todos|todas|tutti|tutto|everything)';
/** "Accept all choices" still accepts everything, so explicit "all" wording keeps the accept reading. */
const SAYS_ALL = new RegExp(`\\b${ALL_WORD}\\b`, 'i');
const ACCEPTS_ALL = new RegExp(`\\b${ACCEPT_WORD}\\b.*\\b${ALL_WORD}\\b|\\b${ALL_WORD}\\b.*\\b${ACCEPT_WORD}\\b`, 'i');

const CONTROL_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="link"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="checkbox"]',
  '[role="switch"]',
  '[role="checkbox"]',
].join(',');

const MAX_TEXT = 1500;
/** Matches `DialogReading.maxControls` in Shared/ConsentDecider.swift. */
const MAX_CONTROLS = 30;
/** Consent dialogs say what they are about early; page wrappers that mention cookies in a footer do not. */
const CONSENT_TEXT_WITHIN = 600;
const MAX_LABEL = 80;

/** Every HTML element under `root`, including inside open shadow roots (and `root`'s own). */
function* allElements(root: Document | ShadowRoot | HTMLElement): Generator<HTMLElement> {
  if (root instanceof HTMLElement && root.shadowRoot) yield* allElements(root.shadowRoot);
  for (const el of root.querySelectorAll('*')) {
    if (!(el instanceof HTMLElement)) continue;
    yield el;
    if (el.shadowRoot) yield* allElements(el.shadowRoot);
  }
}

/** On screen with a real size, and not hidden or transparent through itself or an ancestor. */
export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

/** A frame's body is often zero-height under a fixed dialog, so it counts as visible while its buttons are. */
export function isDialogVisible(dialog: HTMLElement): boolean {
  if (dialog !== document.body) return isVisible(dialog);
  return collectControls(dialog).some((el) => kindOf(el) !== 'toggle' && isVisible(el));
}

function isOverlay(el: HTMLElement): boolean {
  if (el instanceof HTMLDialogElement) return el.open;
  const role = el.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true') return true;
  const position = getComputedStyle(el).position;
  return position === 'fixed' || position === 'sticky';
}

/** Rendered text, plus the text of any open shadow roots inside, which `innerText` skips. */
function textOf(el: HTMLElement): string {
  let text = el.innerText ?? '';
  for (const host of [el, ...allElements(el)]) {
    if (host.shadowRoot) text += ` ${host.shadowRoot.textContent ?? ''}`;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function looksLikeConsent(el: HTMLElement): boolean {
  return CONSENT_TEXT.test(textOf(el).slice(0, CONSENT_TEXT_WITHIN)) && collectControls(el).length > 0;
}

/**
 * Visible overlays (fixed, sticky, or dialog) whose text reads like a consent request and that
 * contain at least one control, outermost first. In a frame, such as a consent platform's own
 * iframe, the whole document can be the dialog.
 */
export function findConsentDialogs(): HTMLElement[] {
  if (window !== window.top) {
    const body = document.body;
    const big = window.innerWidth * window.innerHeight > 40_000;
    return body && big && looksLikeConsent(body) && isDialogVisible(body) ? [body] : [];
  }
  const dialogs: HTMLElement[] = [];
  for (const el of allElements(document)) {
    if (dialogs.some((d) => d.contains(el))) continue;
    if (isOverlay(el) && isVisible(el) && looksLikeConsent(el)) dialogs.push(el);
  }
  return dialogs;
}

export function labelOf(el: HTMLElement): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  const fromLabelledBy = labelledBy
    ?.split(/\s+/)
    .map((id) => el.ownerDocument.getElementById(id)?.innerText ?? '')
    .join(' ');
  const input = el instanceof HTMLInputElement ? el : null;
  const fromLabels = input?.labels?.[0]?.innerText;
  const raw =
    el.getAttribute('aria-label') ||
    fromLabelledBy ||
    (input && (input.type === 'button' || input.type === 'submit') ? input.value : '') ||
    fromLabels ||
    el.innerText ||
    el.title ||
    // Unlabelled toggles usually sit next to their category name.
    (input || el.getAttribute('role') ? (el.parentElement?.parentElement?.innerText ?? '') : '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}

export function kindOf(el: HTMLElement): Control['kind'] {
  const role = el.getAttribute('role');
  if ((el instanceof HTMLInputElement && el.type === 'checkbox') || role === 'switch' || role === 'checkbox') return 'toggle';
  if (el.tagName === 'A' || role === 'link') return 'link';
  return 'button';
}

export function isChecked(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute('aria-checked') === 'true';
}

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
}

/** Autoconsent's reading of a label, minus "accept" for buttons that save a selection. */
function hintFor(label: string): Control['hint'] {
  const hint = classifyButtonTextRegex(label);
  if (hint === 'other') return undefined;
  if ((hint === 'accept' || hint === 'acknowledge') && SAVES_SELECTION.test(label) && !SAYS_ALL.test(label)) return undefined;
  return hint;
}

/** Labels the extension never clicks: accepting everything, paying, subscribing, or logging in. */
export function isForbidden(label: string): boolean {
  return hintFor(label) === 'accept' || ACCEPTS_ALL.test(label) || PAYWALL.test(label);
}

/**
 * A link that would load another page or open a tab, judged by where it resolves (so `<base>`
 * counts). Only links to this same document, or `javascript:` handlers, are clickable.
 */
export function navigates(el: HTMLElement): boolean {
  if (!(el instanceof HTMLAnchorElement)) return false;
  const target = el.target || document.querySelector('base[target]')?.getAttribute('target') || '';
  if (target !== '' && target !== '_self') return true;
  if (el.protocol === 'javascript:') return false;
  const here = new URL(location.href);
  return el.origin !== here.origin || el.pathname !== here.pathname || el.search !== here.search;
}

/**
 * Clickable elements in the dialog: recognised consent buttons first, then other buttons,
 * toggles, and links. Toggles count even when visually hidden, since custom switches often hide
 * the real checkbox behind a styled label. Links that load another page are left out.
 */
export function collectControls(dialog: HTMLElement): HTMLElement[] {
  const kept: HTMLElement[] = [];
  for (const el of allElements(dialog)) {
    if (!el.matches(CONTROL_SELECTOR) || isDisabled(el) || navigates(el)) continue;
    // Skip controls nested in another control, e.g. a <span role=button> inside a <button>.
    if (kept.some((outer) => outer.contains(el))) continue;
    if ((kindOf(el) === 'toggle' || isVisible(el)) && labelOf(el) !== '') kept.push(el);
  }
  // Recognised consent buttons first, so a long settings view cannot push "Reject all" past the cut.
  const rank = (el: HTMLElement) => {
    const kind = kindOf(el);
    if (kind !== 'toggle' && hintFor(labelOf(el))) return 0;
    return { button: 1, toggle: 2, link: 3 }[kind];
  };
  return kept
    .map((el) => ({ el, rank: rank(el) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ el }) => el)
    .slice(0, MAX_CONTROLS);
}

export function describeControls(controls: HTMLElement[]): Control[] {
  return controls.map((el, index) => {
    const kind = kindOf(el);
    const label = labelOf(el);
    if (kind === 'toggle') return { index, kind, label, checked: isChecked(el) };
    const hint = hintFor(label);
    return { index, kind, label, ...(hint && { hint }), ...(isForbidden(label) && { forbidden: true }) };
  });
}

export function dialogText(dialog: HTMLElement): string {
  return textOf(dialog).slice(0, MAX_TEXT);
}

/** Media and frames are page content, never a consent backdrop. */
const CONTENT = 'canvas, video, img, iframe, svg, picture, object, embed';

/**
 * Hide a consent dialog plus any empty full-screen backdrop, close it if it is a modal
 * `<dialog>`, and undo the scroll lock that modal banners put on the page.
 */
export function hideDialog(dialog: HTMLElement) {
  if (dialog instanceof HTMLDialogElement) dialog.close();
  dialog.style.setProperty('display', 'none', 'important');
  const viewport = window.innerWidth * window.innerHeight;
  for (const el of allElements(document)) {
    if (el === dialog || !isVisible(el) || getComputedStyle(el).position !== 'fixed') continue;
    const rect = el.getBoundingClientRect();
    const empty = textOf(el) === '' && ![el, ...allElements(el)].some((inner) => inner.matches(CONTENT));
    if (rect.width * rect.height >= viewport * 0.9 && empty) el.style.setProperty('display', 'none', 'important');
  }
  for (const el of [document.documentElement, document.body]) {
    if (getComputedStyle(el).overflowY === 'hidden') el.style.setProperty('overflow', 'auto', 'important');
  }
}
