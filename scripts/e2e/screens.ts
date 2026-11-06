// What each step of the first run should show: the exact words the code draws, so a step
// passes on the screen a person would see. screens.test.ts holds every one of them to the source, so changing a
// screen's wording fails a test here rather than the live run.

export const SCREENS = {
  welcome: ["Welcome to Candle", "Guided setup", "Straight in"],
  signIn: ["Sign in to Candle", "Candle signs this machine in with a device code"],
  signInPane: ["waiting for you to approve in your browser"],
  noKeychain: ["This machine has no keychain", "Copy the line", "CANDLE_KEYRING_PASSPHRASE"],
  engine: ["Connect your agent", "── test it"],
  harnessRow: ["not signed in"],
  harnessPane: ["finish signing in in your browser"],
  testAnswered: ["step 3: your agent's key, wallet and limits"],
  vault: ["A vault now, or the embedded wallet only for now?", "Pick one of two:"],
  key: ["Your agent's key", "Make the key"],
  keyNotAuthorized: ["Candle won't make a key yet", "Try again"],
  wallet: ["The embedded wallet", "pays from"],
  limits: ["Limits for", "Use these limits"],
  approvals: ["How ", "trades are approved"],
  fund: ["or start on paper", "Start on paper"],
  funded: ["funded"],
  tour: ["→ next · ← back · esc ends it"],
  tourLast: ["⏎ ends the tour · ← back"],
  start: ["Where do you want to start?", "Trade", "Cockpit"],
  setUp: ["Set up, and ready"],
  setupBar: ["ctrl-c ×2 quits"],
  paneDone: ["⏎ or Esc closes the pane"],
  /** The hint line while a card waits for Enter: a card that ended earlier doesn't show it. */
  cardWaiting: ["⏎ approve"],
} as const satisfies Record<string, readonly string[]>

/** The menu row a step picks, as drawn after the highlight's "▸ ". */
export const PICKS = {
  guided: "Guided setup",
  signIn: "Sign in to Candle",
  signInAgain: "Sign in again as",
  useAccount: "Use this account",
  claudeCode: "Claude Code",
  test: "Send a test message",
  continue: "Continue",
  embeddedOnly: "1  The embedded wallet only, for now",
  makeKey: "Make the key",
  tryAgain: "Try again",
  embedded: "The embedded wallet",
  keepLimits: "Use these limits",
  paper: "Start on paper",
  trade: "Trade",
} as const
