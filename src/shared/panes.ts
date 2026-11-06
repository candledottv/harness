// The panes a layout can hold, by id, shared by the view (layouts, the registry) and the core, which
// keeps which ones are popped out into a split of their own.

export const PANE_IDS = [
  "agent",
  "token",
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
] as const
export type PaneId = (typeof PANE_IDS)[number]

/** The panes that can pop out: every one but the agent's conversation, which stays with the input line and its cards. */
export const POPPABLE: readonly PaneId[] = PANE_IDS.filter((p) => p !== "agent")

export const isPoppable = (value: unknown): value is PaneId => typeof value === "string" && (POPPABLE as readonly string[]).includes(value)

/** Where a popped token pane's pin is kept: it has no tab, so it has a place of its own (view-state.ts). */
export const POPPED_AT = "popped out"
