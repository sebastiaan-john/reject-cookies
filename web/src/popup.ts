import browser from './browser';
import { request } from './messaging';
import type { Outcome } from './protocol';

function describe(outcome: Outcome | null): string {
  if (!outcome) return 'No cookie banner handled on this page.';
  switch (outcome.method) {
    case 'rule':
      return outcome.cosmetic ? `Hid the ${outcome.cmp} banner.` : `Rejected via ${outcome.cmp}.`;
    case 'model':
      return `On-device model clicked ${outcome.clicked.map((label) => `“${label}”`).join(', then ')}.`;
    case 'hidden':
      return outcome.clicked.length
        ? `Clicked ${outcome.clicked.map((label) => `“${label}”`).join(', ')}, then hid the banner.`
        : 'Hid a banner that had no reject option.';
    case 'failed':
      return `Something went wrong: ${outcome.error}`;
  }
}

async function render() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const status = document.getElementById('status')!;
  const toggle = document.getElementById('enabled') as HTMLInputElement;
  const model = document.getElementById('model')!;
  const host = tab?.url ? new URL(tab.url).hostname : '';
  if (tab?.id === undefined || !host) {
    status.textContent = 'Open a website to see what happened there.';
    toggle.disabled = true;
    return;
  }

  const state = await request({ type: 'rc:popupState', tabId: tab.id, host });
  document.getElementById('host')!.textContent = host;
  status.textContent = describe(state.outcome);
  toggle.checked = state.enabled;
  model.textContent = state.model.available
    ? 'On-device model ready'
    : `On-device model unavailable${state.model.reason ? `: ${state.model.reason}` : ''}`;
  toggle.addEventListener('change', async () => {
    await request({ type: 'rc:setSiteEnabled', host, enabled: toggle.checked });
    // Reload either way, so a page that was being handled stops, and one that was not starts.
    if (tab.id !== undefined) await browser.tabs.reload(tab.id);
  });
}

render();
