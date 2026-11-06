// The tour's six stops, in order: what each lights and says. Kept apart from tour.tsx, which draws
// them, so the key reducer counts them without drawing anything.
export type TourStopId = "agent" | "positions" | "card" | "kill" | "settings" | "palette"

export const TOUR_STOPS: readonly { id: TourStopId; title: string; words: string }[] = [
  { id: "agent", title: "Your agent", words: "Ask it anything, or type a command like buy $5 of JUP. Anything that spends money comes to you as a card first." },
  { id: "positions", title: "Positions", words: "What you hold, at the newest price. ↑/↓ or a click on a row picks its token: the token pane follows it, and your agent is told." },
  { id: "card", title: "A card", words: "A trade your agent proposes waits here, in its pane, as a card like this one. ⏎ approves it with the input line empty; ctrl-n rejects it; ctrl-o shows everything it's bound to." },
  { id: "kill", title: "The kill switch", words: "ctrl-x twice, or a click here, stops your agent and pauses buys at once. Sells you have open stay one press." },
  { id: "settings", title: "settings ▾", words: "What's set up once: which tabs show, each tab's layout, the theme, your agent's model and memory, aliases, the P&L window, and approvals." },
  { id: "palette", title: "The palette", words: "ctrl-k, from anywhere: every action, tab, pane, setting and candle command, found by typing. The tour is in it too, to run again." },
]
