// The panes a layout can hold, by id, shared by the view (layouts, the registry) and the core, which
// keeps which ones are popped out into a split of their own.

export const PANE_IDS = [
  "agent",
  "token",
  // More token panes side by side, to compare tokens: each pinned on a token of its own while the first follows the link.
  "token:2",
  "token:3",
  "positions",
  "wallets",
  "activity",
  "feed",
  "signals",
  // Candle's other three lists (Feed stays On Fire), P&L, the Journal, Research's four and the Perps stub.
  "new",
  "graduated",
  "final-stretch",
  "pnl",
  "pnl-chart",
  "pnl-positions",
  "trades",
  "journal",
  "check",
  "traders",
  "token-signals",
  "mentions",
  "perps",
  // One list to pick from, switched, so Research pairs with a trending or signals list.
  "lists",
  // While you were away: the last gap's summary.
  "away",
  // The triggers: each one on or off and how it runs, for a layout of your own.
  "triggers",
  // Rules bots: the list, and the picked bot in full.
  "bots",
  "bot",
  // The Build tab: the person's own coding harness in a terminal, the bots folder beside it, and the paper test running.
  "build",
  "build-folder",
  "build-test",
] as const
export type PaneId = (typeof PANE_IDS)[number]

/** The token panes a layout can hold, the first first: it follows the link, and the others are opened pinned. */
export const TOKEN_PANES = ["token", "token:2", "token:3"] as const satisfies readonly PaneId[]
export type TokenPane = (typeof TOKEN_PANES)[number]
export const isTokenPane = (value: unknown): value is TokenPane => typeof value === "string" && (TOKEN_PANES as readonly string[]).includes(value)

/**
 * The panes a layout holding `on` can open: every pane not on it, but of the token panes only the next
 * one, once the first is on ("open another token pane" rather than three rows of the same).
 */
export function openable(on: readonly PaneId[]): PaneId[] {
  const nextToken = TOKEN_PANES.find((t) => !on.includes(t))
  return PANE_IDS.filter((p) => !on.includes(p) && (!isTokenPane(p) || p === nextToken))
}

/**
 * The panes that can pop out: every one but the agent's conversation, which stays with the input line and its cards,
 * and the Build pane's terminal, whose harness runs in this view's own process.
 */
export const POPPABLE: readonly PaneId[] = PANE_IDS.filter((p) => p !== "agent" && p !== "build")

export const isPoppable = (value: unknown): value is PaneId => typeof value === "string" && (POPPABLE as readonly string[]).includes(value)

/** Where a popped token pane's pin is kept: it has no tab, so it has a place of its own (view-state.ts), by the pane it is. */
export const POPPED_AT = "popped out"
