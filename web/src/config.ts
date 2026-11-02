import type { Config } from '@duckduckgo/autoconsent';

/** Opt out everywhere; click a heuristic "reject" button only when one exists. */
export const AUTOCONSENT_CONFIG: Partial<Config> = {
  autoAction: 'optOut',
  enablePrehide: true,
  enableCosmeticRules: true,
  enableGeneratedRules: true,
  enableHeuristicDetection: true,
  heuristicMode: 'reject',
  enablePopupMutationObserver: true,
  detectRetries: 20,
};
