// What a code bot says, as an event a trigger can wait on: one word and a line ("needs-a-look", "spread above 8%").
// `on bot "<name>" says "<word>"` fires on it with its cooldown, wake caps and the kill switch, as any event does,
// so a bot asks for judgment without a model on every tick.
//
// - **The word** is lowercase letters, digits and dashes, up to 24, starting with a letter or digit: what a
//   trigger names. **The line** is the bot's own words, up to 200 characters once cleaned, made one line. Angle
//   brackets become ‹ ›, so the line can't close the fence a woken turn reads it in.
// - **At most one of a word every 10 s, and 30 a minute,** per bot: a bot in a loop can't fill the journal or
//   fire a trigger over and over. Past either, it's refused in words and nothing is kept.
// - **Journalled** as the bot's `bot.event` row, which is all a trigger reads: what it said is in the Journal and
//   Activity in its words, and a woken turn gets it fenced as data.
import { refused } from "../shared/rpc"
import { terminalText } from "../shared/terminal-text"

export const BOT_EVENT_WORD = /^[a-z0-9][a-z0-9-]{0,23}$/
export const BOT_EVENT_TEXT_MAX = 200
/** One of a word, per bot, at most this often. */
export const BOT_EVENT_WORD_MS = 10_000
/** Every word, per bot, at most this many a minute. */
export const BOT_EVENT_PER_MINUTE = 30

export interface BotEventTaken {
  word: string
  text?: string
}

const bad = (words: string): never => {
  throw refused("INVALID_PARAMS", words)
}

/** A bot's event's line, made safe: cleaned, one line, angle brackets that could close a fence turned to ‹ ›. */
export function eventText(v: string): string {
  return terminalText(v)
    .replace(/\s+/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .trim()
}

export class BotEvents {
  /** Each bot's events in the last minute, newest last: by word, and in all. */
  private readonly said = new Map<string, { word: string; at: number }[]>()

  constructor(private readonly now: () => number) {}

  /** Checks a bot's event and counts it, or refuses it in words. The caller journals what it answers. */
  take(bot: string, params: Record<string, unknown>): BotEventTaken {
    for (const k of Object.keys(params)) if (k !== "word" && k !== "text" && params[k] !== undefined) bad(`${k} isn't part of an event: it takes word and text.`)
    const word = typeof params.word === "string" ? params.word : bad("word is one lowercase word: letters, digits and dashes, up to 24.")
    if (!BOT_EVENT_WORD.test(word)) bad(`"${eventText(word).slice(0, 40)}" isn't an event's word: one lowercase word of letters, digits and dashes, up to 24, starting with a letter or digit.`)
    let text: string | undefined
    if (params.text !== undefined && params.text !== null) {
      if (typeof params.text !== "string") bad("text is the event's line, as text.")
      text = eventText(params.text as string)
      if ([...text].length > BOT_EVENT_TEXT_MAX) bad(`text is ${[...text].length} characters, over its ${BOT_EVENT_TEXT_MAX}.`)
      if (!text) text = undefined
    }
    const now = this.now()
    const recent = (this.said.get(bot) ?? []).filter((e) => now - e.at < 60_000)
    const last = recent.findLast((e) => e.word === word)
    if (last && now - last.at < BOT_EVENT_WORD_MS) {
      throw refused("TOO_SOON", `It said "${word}" ${Math.max(1, Math.round((now - last.at) / 1000))} s ago: one "${word}" every ${BOT_EVENT_WORD_MS / 1000} s. Nothing was kept, and no trigger fired.`)
    }
    if (recent.length >= BOT_EVENT_PER_MINUTE) throw refused("TOO_MANY", `It said ${recent.length} things in the last minute, its ${BOT_EVENT_PER_MINUTE}. Nothing was kept, and no trigger fired.`)
    recent.push({ word, at: now })
    this.said.set(bot, recent)
    return { word, ...(text ? { text } : {}) }
  }
}
