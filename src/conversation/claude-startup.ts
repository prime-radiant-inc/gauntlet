const STARTUP_FAILURE_MARKERS = [
  "Choose the text style",
  "Choose your preferred theme",
  "Security notes",
  "Trust this folder",
  "Yes, I accept",
  "Bypass Permissions mode",
  "Select login method",
  "Log in to your account",
  "Not logged in",
  "Invalid API key",
];

/** Recognize the configured Claude composer observed by the startup probe. */
export function isClaudeReady(screen: string): boolean {
  const lower = screen.toLowerCase();
  if (STARTUP_FAILURE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) {
    return false;
  }
  return (
    /Claude Code v\d+\.\d+\.\d+/.test(screen) &&
    /^\s*❯\s*$/m.test(screen) &&
    lower.includes("bypass permissions on")
  );
}
