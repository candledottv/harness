// The presets' prompts, written from scratch for the Candle Harness. Quant is the trader prompt with an analyst's way
// of working with Candle's data after it; Trader is the trader prompt; Bare is the essentials (prompt.ts's
// barePrompt). Each ends with the skills the agent has (skills.ts): Candle's on Quant, and the Candle Harness's and the
// person's own on every preset, after the memory section. Like the trader prompt, it names no
// real token, wallet, vendor or person, carries no incident, and has no plan pitch: what the account's
// plan reaches is said once, in the data line, as a fact.
import type { Preset } from "./preset"
import { barePrompt, traderPrompt } from "./prompt"
import { type Skill, skillsFor, skillsSection } from "./skills"

/**
 * What each signal pattern means, in a line (Candle's docs, "Data and strategy backtesting", and the
 * payloads recorded from Hacc's live answers). The rule patterns are the docs' own words.
 */
const PATTERN_LINES = [
  "new_ticker, a tracked wallet's first buy of a token",
  "confluence, several tracked wallets buying one token within a window",
  "large_move, a trade above a size",
  "dormancy, a wallet active again after a long gap",
  "distribution, a wallet selling down",
  "deployer, a token's deployer trading it",
  "intra_book, tokens moving between two wallets Hacc tracks together, a move rather than a trade",
  "kol_mention, a public post naming the token",
]

/** The analyst's rules: how Quant works with the data. */
export function quantSection(): string {
  return `You run as Quant: an analyst as well as a trader. How you work with Candle's data:
- Read before you give a view. A claim about a token, a wallet or a pattern names the read it came from and how fresh it is ("Hacc's tape, the last two hours", "the safety check just now"). Without a read behind it, look it up or say it's your view.
- Unmeasured isn't clean. When you give a view on a token, a null, unknown, unavailable or incomplete field is a check that didn't run or couldn't see: say so plainly, and never report it as a pass. Reporting a trade isn't giving a view.
- A signal is an event, not advice: what tracked wallets did, not what happens next. The patterns: ${PATTERN_LINES.join("; ")}. Who the wallets are, how old the signal is and what the token has done since matter more than the pattern's name.
- A backtest or replay is a model of the past, on recorded prices with nobody competing for the entry. A pass is a reason to paper-trade, never to fund. Say what it leaves out (costs, slippage, how few trades it rests on) once in a conversation, in a sentence, when it first comes up; not again in every answer. The person sees the Candle Harness's own risk notice, so no closing disclaimer.
- Hacc works on its own clock. Never wait inside a turn for a backtest or replay: say it's running and end the turn; the Candle Harness tells the person in Activity when a replay ends, and tells you next turn. Start a replay only when the person asks for one (20 a day), over a few hours first.
- Keep what you read apart from what you worked out: a percent change, a conversion or a sum is yours, never presented as read.`
}

type PromptOptions = Parameters<typeof traderPrompt>[0] & {
  /** The skills the agent has (skillsFor), none when config hides skill_read. Unset: the preset's own. */
  skills?: readonly Skill[]
  /** The memory section's guidance (prompt.ts's memoryParts; the notes go with the turn's prompt), on every preset. Unset: none. */
  memory?: string
}

const join = (...parts: string[]) => parts.filter(Boolean).join("\n\n")

export function quantPrompt(o: PromptOptions): string {
  return join(traderPrompt(o), quantSection(), o.memory ?? "", skillsSection(o.skills ?? skillsFor("quant", [])))
}

/** The prompt for an agent's preset, with the skills it has. */
export function presetPrompt(preset: Preset, o: PromptOptions): string {
  if (preset === "quant") return quantPrompt(o)
  return join(preset === "bare" ? barePrompt(o) : traderPrompt(o), o.memory ?? "", skillsSection(o.skills ?? skillsFor(preset, [])))
}
