// One table of every key: its action, its
// chord, where it works and what it does. The reducer matches chords through it (pressed), help lists it,
// the palette's key column names it, and the hint line beside the input line says what Enter, Esc and
// ctrl-k do here. So a key can't drift from what the screen says about it. keymap.test.ts presses every
// ctrl-letter and named key and fails on one that acts without a row here.
//
// Two rules stay as they were, whatever the table says: ctrl-x twice is the kill switch from anywhere,
// overlays included; and Enter approves the focused card only with the line empty, 300 ms
// after it showed. The palette never approves: its approve row says why.
import { TYPED_ROWS } from "../shared/commands"
import type { Key } from "./keys"

export type KeyId =
  | "approve"
  | "send"
  | "reject"
  | "details"
  | "requote"
  | "ask"
  | "stop"
  | "search"
  | "searchJournal"
  | "kill"
  | "palette"
  | "help"
  | "commands"
  | "picker"
  | "popOut"
  | "oneAgent"
  | "panes"
  | "scroll"
  | "tabDigit"
  | "promptPane"
  | "buildPane"
  | "edit"
  | "clearLine"
  | "lineEnds"
  | "quit"

/** A key that makes an action: its name as OpenTUI reports it, or the character typed (`?`), and whether ctrl is held. */
export interface Chord {
  name?: string
  sequence?: string
  ctrl?: true
}

/** What the hint line knows about here: the line, the card Enter would approve, and the agent at work. */
export interface Here {
  empty: boolean
  /** A card Enter would approve, with the line empty. */
  card: boolean
  /** That card arrived under another a moment ago, and Enter doesn't take it yet. */
  cardSoon?: true
  /** The tab bar has the keys: there, a digit picks a tab. */
  tabs?: true
  /** The active agent, while it has a turn running or waiting. */
  working?: string
  /** What Enter does with the text on the line: "to agent-a", "runs it", "says why". */
  sends?: string
  /** The focused pane, when it can pop out: what ctrl-p would move (popping out by the last-clicked pane took the wrong one). */
  pops?: string
  /** The Journal's search line takes the keys: Enter and Esc are its own. */
  searching?: boolean
  /** The Journal has focus, its search line not yet: ↑ from its first row types into it. */
  journal?: boolean
  /** The Build pane has focus: its harness running (every key is the harness's but ctrl-]), or its own screen, where ⏎ goes on or starts it. */
  /** `card`: a bot's card opened over the harness while the person typed there; the keys are still the harness's, and ctrl-] moves to the card. */
  build?: "running" | "start" | "card"
}

export interface KeyDef {
  id: KeyId
  /** As shown: in help, the palette's key column and the hint line. */
  chord: string
  /** The keys that make it. None for one the frame takes before the step (ctrl-], to the prompt pane). */
  keys: readonly Chord[]
  /** Where it works, in words, when not anywhere. */
  where?: string
  /** What it does. */
  words: string
  /** What the hint line says for it here; undefined, it isn't shown. */
  hint?: (here: Here) => string | undefined
  /**
   * A palette row of its own, in "Actions": `label`, and `why` when picking the row can't do it (the row says
   * the key instead). No `palette`, it's in help only (moving the cursor means nothing from a list).
   */
  palette?: { label: string; why?: string }
  /** Taken by the frame before the step (the prompt pane's ctrl-]). */
  frame?: true
}

const ctrl = (name: string): Chord => ({ name, ctrl: true })

export const KEYMAP: readonly KeyDef[] = [
  {
    id: "approve",
    chord: "⏎",
    keys: [{ name: "return" }, { name: "enter" }],
    where: "with the line empty",
    words: "approve the highlighted card, once it has shown for 300 ms (1.5 s when it arrived while another card was waiting)",
    // Not while the Build pane has the keys: ⏎ is its harness's, or its own screen's.
    hint: (h) => (h.empty && h.card && !h.searching && !h.build ? (h.cardSoon ? "approves in a moment" : "approve") : undefined),
    palette: { label: "approve", why: "only ⏎ with the line empty, or a click on the card, approves: a pick in the palette never trades" },
  },
  {
    id: "send",
    chord: "⏎",
    keys: [{ name: "return" }, { name: "enter" }],
    where: "with text on the line",
    words: "send it, as a command or to the agent",
    hint: (h) => (h.empty ? undefined : h.sends),
  },
  { id: "reject", chord: "ctrl-n", keys: [ctrl("n")], words: "reject the highlighted card", palette: { label: "reject" } },
  { id: "details", chord: "ctrl-o", keys: [ctrl("o")], words: "see everything the highlighted card is bound to", palette: { label: "card details" } },
  { id: "requote", chord: "ctrl-r", keys: [ctrl("r")], words: "re-quote the newest expired card at the current price", palette: { label: "re-quote" } },
  { id: "ask", chord: "ctrl-t", keys: [ctrl("t")], words: "ask the agent: about the highlighted row, a question put on the line; or a trade naming a token nobody has shown, sent as typed", palette: { label: "ask the agent" } },
  {
    id: "stop",
    chord: "esc",
    keys: [{ name: "escape" }],
    where: "with the line empty",
    words: "stop the agent's turn; a message waiting runs next",
    hint: (h) => (h.empty && h.working && !h.searching ? `stop ${h.working}'s turn` : undefined),
    palette: { label: "stop the turn" },
  },
  {
    id: "search",
    chord: "esc",
    keys: [],
    where: "in the Journal's search",
    words: "give the keys back to the input line; ↑ from the Journal's first row, or its search chip, types into it again, and ⏎ keeps the search",
    hint: (h) => (h.searching ? "back to the line" : undefined),
  },
  {
    id: "searchJournal",
    chord: "↑",
    keys: [],
    where: "on the Journal's first row",
    words: "type into the Journal's search line: words, a token, an agent; it searches everything recorded",
    hint: (h) => (h.journal && !h.searching && h.empty ? "search" : undefined),
  },
  { id: "kill", chord: "ctrl-x twice", keys: [ctrl("x")], words: "kill switch: pause buys, stop the agent; sells still work", palette: { label: "kill switch" } },
  {
    id: "palette",
    chord: "ctrl-k",
    keys: [ctrl("k")],
    words: "the palette: every action, tab, layout, pane, agent, preset, token and Candle command",
    hint: () => "palette",
  },
  { id: "help", chord: "?", keys: [{ sequence: "?" }], where: "with the line empty", words: "the commands you can type, and every key", palette: { label: "help" } },
  { id: "commands", chord: "? then c", keys: [{ sequence: "c" }], where: "in help", words: "the palette at Candle's commands, each a request for the agent" },
  { id: "picker", chord: "ctrl-g", keys: [ctrl("g")], words: "the agent's preset, engine and model, from its next turn" },
  {
    id: "popOut",
    chord: "ctrl-p",
    keys: [ctrl("p")],
    where: "on a pane",
    words: "pop the focused pane out into a tmux or cmux split of its own; it comes back when you close it there",
    hint: (h) => (h.empty && h.pops ? `pop out ${h.pops}` : undefined),
  },
  { id: "oneAgent", chord: "ctrl-f", keys: [ctrl("f")], words: "positions, wallets, activity: all agents, or the active one", palette: { label: "one agent or all" } },
  {
    id: "panes",
    chord: "tab · ←/→ · ↑/↓",
    keys: [{ name: "tab" }, { name: "left" }, { name: "right" }, { name: "up" }, { name: "down" }],
    words: "move between panes; ↑/↓ in a list picks a row's token",
  },
  { id: "scroll", chord: "PgUp/PgDn · wheel", keys: [{ name: "pageup" }, { name: "pagedown" }], words: "scroll the focused pane, or the one under the mouse" },
  {
    id: "tabDigit",
    chord: "1-9",
    keys: [],
    where: "on the tab bar",
    words: "pick a tab: press tab until the tab bar has the keys, then its digit; or click it, or find it in the palette (on the line, a digit types)",
    hint: (h) => (h.tabs && h.empty ? "a tab" : undefined),
  },
  {
    id: "promptPane",
    chord: "ctrl-]",
    keys: [],
    words: "leave the CLI prompt pane or the Build pane's harness, or come back to it",
    hint: (h) => (h.build === "running" ? "leaves the pane" : h.build === "card" ? "to the bot's card" : undefined),
    frame: true,
  },
  {
    id: "buildPane",
    chord: "⏎",
    keys: [],
    where: "in the Build pane, before its harness runs",
    words: "go on through the first open, or start your coding harness in the bots folder",
    hint: (h) => (h.build === "start" ? "start" : undefined),
    frame: true,
  },
  {
    id: "edit",
    chord: "←/→ · home/end · ⌫",
    keys: [{ name: "backspace" }, { name: "delete" }, { name: "home" }, { name: "end" }],
    where: "with text on the line",
    words: "edit the line",
  },
  { id: "clearLine", chord: "ctrl-u", keys: [ctrl("u")], words: "clear the line" },
  { id: "lineEnds", chord: "ctrl-a · ctrl-e", keys: [ctrl("a"), ctrl("e")], words: "the start or end of the line" },
  {
    id: "quit",
    chord: "ctrl-c twice",
    keys: [ctrl("c")],
    words: "quit; once clears the line, closes what's open, or copies text selected with the mouse",
    palette: { label: "quit", why: "only ctrl-c twice quits, so a stray pick can't" },
  },
]

const BY_ID = new Map(KEYMAP.map((d) => [d.id, d]))

export const keyDef = (id: KeyId): KeyDef => BY_ID.get(id)!

/** The chord as shown, for the palette's key column and the hint line. */
export const chordOf = (id: KeyId): string => keyDef(id).chord

const matches = (c: Chord, key: Key): boolean =>
  (c.name === undefined || c.name === key.name) && (c.sequence === undefined || c.sequence === key.sequence) && !!c.ctrl === !!key.ctrl

/** Whether `key` makes the action `id`. */
export const pressed = (key: Key, id: KeyId): boolean => keyDef(id).keys.some((c) => matches(c, key))

/** Help's label column: the typed commands' and the keys'. */
export const HELP_COLUMN = 23

/** What `?` shows of the typed commands: each row's form, then its words, laid out to help's column. */
export const HELP_LINES: readonly string[] = TYPED_ROWS.map((r) => `${r.form.padEnd(HELP_COLUMN - 1)} ${r.help}`)

/** Help's key lines: the chord, then where and what it does. */
export function keyLines(): string[] {
  return KEYMAP.map((d) => `${d.chord.padEnd(HELP_COLUMN)}${d.where ? `${d.where}: ` : ""}${d.words}`)
}

/** What the hint line shows here, in the table's order: each chord and its words. */
export function hintsHere(here: Here): { id: KeyId; chord: string; words: string }[] {
  return KEYMAP.flatMap((d) => {
    const words = d.hint?.(here)
    return words ? [{ id: d.id, chord: d.chord, words }] : []
  })
}
