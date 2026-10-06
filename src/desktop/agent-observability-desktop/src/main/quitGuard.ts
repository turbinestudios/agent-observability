/**
 * Whether quitting should ask first, and what it says. Pure, so the rule is
 * testable without Electron: the app asks only when it is hosting sessions.
 */
export function shouldConfirmQuit(activeRuns: number): boolean {
  return Number.isFinite(activeRuns) && activeRuns > 0;
}

export function quitMessage(activeRuns: number): string {
  return activeRuns === 1
    ? 'A session you started in Run is still going. Quit anyway?'
    : `${activeRuns} sessions you started in Run are still going. Quit anyway?`;
}
