// harness_limits: the agent answers "what can you do without asking me?" from the core's own records. Read
// with no arguments: each wallet it pays from and whether it trades inside limits with its figures and
// today's use, the agent's own Candle Harness limits and Candle's caps on its key, each naming who enforces it
// (limits.ts's lines), and anything holding trades now. With `setting: "ask"` or a lower figure it proposes
// the autonomy's narrowing card; it never widens anything, which only the person does. Described in the
// tool, with one prompt line a turn only where a wallet trades inside limits.
import type { AutonomyWallet } from "./autonomy"
import type { Mode } from "./classify"
import { type KeyHold, type LimitLine, usd } from "./limits"

export const LIMITS_TOOL_NAME = "harness_limits"

export const LIMITS_TOOL = {
  name: LIMITS_TOOL_NAME,
  description:
    "What you may do without asking, and every limit you're held to in this Candle Harness, each naming who enforces it: for each wallet you pay from, whether it trades inside limits (a buy or swap inside its figures, and any sell, runs at once with no card, unless you set a slippage bound looser than the default) or asks every time, its figures and what has run without a card today; your own Candle Harness limits; Candle's caps on your key; and anything holding trades now. Call it with no arguments to read, as for \"what can you do without asking me?\". " +
    "It can't widen anything: only the person turns a wallet on or raises a figure, in settings ▾ → approvals. When they ask you to hold back, pass wallet with setting \"ask\", or a lower perTradeUsd or perDayUsd, and it proposes a card that narrows it, which they approve with one press.",
  inputSchema: {
    type: "object" as const,
    properties: {
      wallet: { type: "string", description: 'To narrow: "embedded", or a TEE wallet\'s label, as the read names it.' },
      setting: { type: "string", enum: ["ask", "inside"], description: '"ask": every trade from it becomes a card again. "inside" with a lower figure: fewer dollars run without a card.' },
      perTradeUsd: { type: "number", description: "To narrow: a lower figure for one trade without a card, in dollars, Candle's fee included." },
      perDayUsd: { type: "number", description: "To narrow: a lower figure for a day's trades without a card, in dollars." },
      reason: { type: "string", description: "Why, in a few words; it shows on the card." },
    },
  },
}

/** Whether a call asks to change anything; with none of these it's a read. */
export const narrows = (args: Record<string, unknown>): boolean => args.setting !== undefined || args.perTradeUsd !== undefined || args.perDayUsd !== undefined

/** A narrowing's arguments for the desk: a figure on its own means "inside", lower. */
export function narrowingArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { reason: _reason, ...rest } = args
  return rest.setting === undefined ? { ...rest, setting: "inside" } : rest
}

/** The person's own words for a wallet: "the embedded wallet", or a TEE wallet's label. */
const named = (w: Pick<AutonomyWallet, "name" | "kind">) => (w.kind === "embedded" || w.name === "embedded" ? "the embedded wallet" : w.name)

const cents = (n: number) => Math.round(n * 100) / 100

/** What the hold on the agent's key means now, in words. */
function holdWords(hold: KeyHold, now: number): string {
  const until = hold.until === null ? undefined : `about ${Math.max(1, Math.round((hold.until - now) / 60_000))} min`
  if (hold.why === "stopped") return `Candle stopped your key for a loss limit or its circuit breaker: every trade waits, sells included, and Candle is asked again in ${until ?? "a while"}. Only the account owner resumes it.`
  if (hold.why === "unavailable") return `Candle couldn't check your key's cap just now: buys and swaps wait ${until ?? "a moment"}. Sells go.`
  if (hold.why === "lifetime") return "Your key has spent Candle's cap for its life: buys and swaps are refused until the owner changes the cap. Sells go."
  return `Your key has spent Candle's cap for its window: buys and swaps are refused for ${until ?? "now"}, until it resets. Sells go.`
}

/** One wallet's line of what runs without asking. */
function walletSentence(w: AutonomyWallet): string {
  if (w.setting !== "inside") return `From ${named(w)}, every trade is a card.`
  const left = Math.max(0, w.perDayUsd! - w.usedTodayUsd)
  // Sells are never limited, so every sell from it runs without a card, unless its slippage bound is looser than the default.
  return `From ${named(w)}, a buy or swap worth up to ${usd(w.perTradeUsd!)} with Candle's fee runs at once with no card, while the day's buys and swaps without a card stay within ${usd(w.perDayUsd!)} (${usd(w.usedTodayUsd)} used, ${usd(left)} left); over either, it's a card. Every sell from it runs without a card, whatever its size. A maxSlippageBps looser than the default makes any trade a card.`
}

export interface LimitsInput {
  agent: string
  mode: Mode
  /** The kill switch's pause. */
  paused: boolean
  /** The limit lines for the agent: its Candle Harness limits, its wallets' figures and Candle's caps. */
  lines: readonly LimitLine[]
  /** The autonomy topic's wallets the agent pays from now (none gone). */
  wallets: readonly AutonomyWallet[]
  /** Whether the agents' wallets have been read. */
  walletsRead: boolean
  own?: { perTradeUsd: number; perDayUsd: number; usedUsd: number }
  hold?: KeyHold
  now: number
}

/** The answer to a harness_limits read. */
export function limitsRead(i: LimitsInput): Record<string, unknown> {
  const withoutCard: string[] = []
  if (i.mode === "paper") withoutCard.push("The Candle Harness is in paper mode: every trade runs at once on paper, with no card and no funds. What follows holds in live mode.")
  if (i.paused) withoutCard.push("The kill switch is on: buys and swaps don't run, with a card or without, until the person resumes. Sells still go.")
  if (i.hold) withoutCard.push(holdWords(i.hold, i.now))
  if (!i.walletsRead && i.wallets.length === 0) withoutCard.push("Your wallets aren't read yet, so until they are, every trade is a card.")
  for (const w of i.wallets) withoutCard.push(walletSentence(w))
  if (i.own) withoutCard.push(`Your own Candle Harness limit, ${usd(i.own.perTradeUsd)} a trade and ${usd(i.own.perDayUsd)} a day (${usd(i.own.usedUsd)} used), refuses anything over it, with a card or without.`)
  withoutCard.push("Everything else you propose (launches, stakes, claims, posts, key and wallet changes, Hacc's rules) is always a card.")
  return {
    success: true,
    agent: i.agent,
    mode: i.mode,
    withoutCard,
    wallets: i.wallets.map((w) => ({
      wallet: w.name,
      setting: w.setting === "inside" ? "trades inside limits" : "asks every time",
      ...(w.setting === "inside"
        ? { perTradeUsd: w.perTradeUsd, perDayUsd: w.perDayUsd, usedTodayWithoutCardUsd: cents(w.usedTodayUsd), leftTodayWithoutCardUsd: cents(Math.max(0, w.perDayUsd! - w.usedTodayUsd)) }
        : {}),
      ...(w.agents.length > 1 ? { alsoPaysFromIt: w.agents.filter((a) => a !== i.agent) } : {}),
      ...(w.notes.length ? { notes: w.notes.map((n) => n.words) } : {}),
    })),
    limits: i.lines.map((l) => ({ by: l.by, words: l.words })),
    notListed:
      "Candle may also hold per-key loss limits and a circuit breaker the account owner set. No tool reads them, so they aren't listed; a breach stops the key, sells included, until the owner resumes it.",
    changing:
      'Only the person turns a wallet on or raises a figure, in settings ▾ → approvals. You may propose narrowing one with this tool: setting "ask", or a lower figure.',
  }
}

/**
 * The prompt's line ahead of each turn: only in live mode and only where a wallet
 * the agent pays from trades inside limits, since otherwise the prompt's "a trade is a card" already holds.
 */
export function autonomyNote(wallets: readonly AutonomyWallet[], agent: string, mode: Mode): string | undefined {
  const own = wallets.filter((w) => !w.gone && w.agents.includes(agent))
  if (mode !== "live" || !own.some((w) => w.setting === "inside")) return undefined
  return `Without a card (the person's setting): ${own.map(walletSentence).join(" ")} When a trade runs without a card, the tool's answer says so in "approved" and carries the result: say it ran, and that it ran without a card. When one is a card all the same, its "why" names the figure it's over: say so in a few words. harness_limits reads the rest.`
}
