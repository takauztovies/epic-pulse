// The ids package.json contributes. A test reads the manifest and checks that
// every one of them is there, so a rename can not leave a dead click behind.
export const COMMAND = {
  refresh: 'epicPulse.refresh',
  openIssue: 'epicPulse.openIssue',
  signIn: 'epicPulse.signIn',
  showStatus: 'epicPulse.showStatus',
  track: 'epicPulse.track',
  untrack: 'epicPulse.untrack',
  openSession: 'epicPulse.openSession',
  openOnGitHub: 'epicPulse.openOnGitHub',
} as const;

export const VIEW_ID = 'epicPulse.epics';

// VS Code registers `<view id>.focus` for every contributed view.
export const FOCUS_VIEW = `${VIEW_ID}.focus`;

export const CONFIG_SECTION = 'epicPulse';
