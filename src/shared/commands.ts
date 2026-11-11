// The input line's commands. A line that parses runs as the user's own request; a
// line that doesn't goes to the agent as plain English, whole, never as a half-parsed trade. A token
// is a mint, or a name only when it was seen this session (the token pane, positions, the feed, a
// card), so a name nobody has shown can't be guessed into a trade.
//
// A line shaped like a trade (buy, sell or swap, then an amount, a dollar figure or a percent) that
// can't run as typed says why and sends nothing: otherwise `sell 100% ORE` on a fresh core would quietly
// become an agent turn and a card where an instant sell was meant.
//
// `from <wallet>` names the wallet that pays: a TEE wallet's label, address or id, or
// `embedded`. It's resolved against the agent's payable wallets from the core's `wallets` topic, by the
// core's own rule (resolvePayer), so a wallet the agent can't pay from is said, in the core's words,
// before anything is sent. The core checks it again when the card is proposed.
//
// Aliases and chains: a line's first word may be an alias from
// config.toml's [aliases] (aliases.ts), replaced and the rest kept. A line is a chain (`buy $1 of JUP; sell
// 100% of JUP`) only when its first part is a command, so English with a semicolon still goes to the agent
// whole. Every part is parsed before anything is sent: a part that isn't a trade or a candle command, or
// that can't run as typed, refuses the whole line with its number and why, and the line stays to fix. The
// frame runs the parts one after another (chain.ts).
import { expandPart, MAX_PARTS, partsOf } from "./aliases"
import { payerContextFrom, resolvePayer, type WalletsTopic } from "../core/agent-wallets"
import type { GroupOp } from "../core/wallet-groups"
import { isAddressShaped, lookupWallet } from "../core/wallet-names"
import { extractAddresses } from "../engine/gate"
import { parseWindow, type PnlWindow } from "../core/pnl"

export type Command =
  | { kind: "trade"; tool: "candle_trade" | "candle_swap"; args: Record<string, unknown>; agent?: string; echo: string }
  | { kind: "mode"; mode: "paper" | "live" }
  | { kind: "kill" }
  | { kind: "resume" }
  /** Re-send or abandon the operation Candle didn't answer. */
  | { kind: "resolve"; action: "resend" | "abandon" }
  | { kind: "help" }
  | { kind: "setAgent"; agent: string }
  /** The P&L window: `pnl 24h`, `pnl since 18:00`, `pnl since last session`. */
  | { kind: "pnlWindow"; window: PnlWindow }
  | { kind: "cli"; argv: string[]; agent?: string }
  /** `name <wallet> <new name>`: the core checks it, and writes it or opens the pane. */
  | { kind: "name"; wallet: string; name: string }
  /** `group <name> add|remove <wallets>`, `group <name> prefix <start>|none`, `group <name> delete`: at once, the core's rule. */
  | { kind: "group"; op: GroupOp }
  /** `forget vault`: the person says this machine's vault is gone on purpose. The core checks there's none. */
  | { kind: "forgetVault" }
  | { kind: "agent"; text: string }
  /**
   * It parsed, but can't run as typed: say why, and send nothing. `keepLine` leaves it to fix; `ask`
   * offers to send the line to the agent as typed, to find the token (ctrl-t or a chip).
   */
  | { kind: "refused"; message: string; keepLine?: boolean; ask?: true; askText?: string }
  /** Two to five parts, each a trade or a candle command, run one after another. */
  | { kind: "chain"; parts: ChainPart[]; echo: string }

/** A chain's part: what it runs, and its words once aliases are expanded. */
export interface ChainPart {
  command: Extract<Command, { kind: "trade" } | { kind: "cli" }>
  text: string
}

export interface CommandContext {
  agents: readonly string[]
  /** Token names seen this session, upper-cased, to their mints. */
  knownTokens: ReadonlyMap<string, string>
  /** Names read for several tokens, upper-cased, to their mints: refused, naming them (the core's reader). */
  severalTokens?: ReadonlyMap<string, readonly string[]>
  /** The agent a line without `as` runs as. */
  activeAgent?: string
  mode?: "paper" | "live"
  /** What each agent can pay from, for `from <wallet>`; absent before the core sends it. */
  wallets?: WalletsTopic
  /** config.toml's [aliases], checked (aliases.ts): by name, lower-cased, to what each becomes. */
  aliases?: ReadonlyMap<string, string>
}

const SPEND = new Set(["sol", "usdc", "cndl"])
const BASE = new Set(["SOL", "USDC", "CNDL", "ETH", "USDG"])
const AMOUNT = /^(?:\d+(?:\.\d+)?|\.\d+)$/
const DOLLARS = /^\$(\d+(?:\.\d{1,2})?)$/
const PERCENT = /^(\d{1,3})%$/

const plain = (line: string): Command => ({ kind: "agent", text: line })
const notTrade = (why: string): Command => ({ kind: "refused", message: `Not a trade yet: ${why}`, keepLine: true })
/**
 * A name nobody has shown: it may match many tokens (copies of a ticker are common), so it's never
 * guessed into a trade. The agent can be asked to find it, and confirms the token with the person, so
 * "Buy $1 of ORE." needn't be retyped as "Please buy…" to reach the agent. A name the core has read for
 * several tokens is refused naming each.
 */
const unknown = (word: string, ctx: CommandContext): Command => {
  const several = ctx.severalTokens?.get(word.replace(/^\$/, "").toUpperCase())
  if (several && several.length > 1) {
    return { kind: "refused", message: `Not a trade yet: ${word} is the name of ${several.length} tokens: ${several.join(", ")}. Name the one you mean by its mint.`, keepLine: true, ask: true }
  }
  return { kind: "refused", message: `Not a trade yet: ${unknownToken(word)}`, keepLine: true, ask: true }
}
/** buy, sell or swap followed by 0.1, $25 or 50%: meant as a trade, so a miss is said, not sent to the agent. */
const tradeShaped = (second: string | undefined) => second !== undefined && (AMOUNT.test(second) || second.startsWith("$") || second.endsWith("%"))
const unknownToken = (word: string) => `${word} isn't a token this session has shown, and a name can match many tokens. Paste its mint, or ask the agent to find it.`

/** The longest trade, less its `as`, `from` and `of`: `buy 0.1 sol MOON`, `swap 0.1 SOL USDC`. */
const TRADE_WORDS = 4

/** A trade-shaped line that reads as a sentence: more words than a trade takes, a clause's comma, brackets, a question, or a full stop mid-line. */
const prose = (line: string, words: readonly string[]): boolean => words.length > TRADE_WORDS || /,\s|[()?;]/.test(line) || /[.!]\s+\S/.test(line)

/** A mint, or a name seen this session. */
function token(word: string, ctx: CommandContext): string | undefined {
  const [address] = extractAddresses(word)
  if (address === word) return address
  return ctx.knownTokens.get(word.replace(/^\$/, "").toUpperCase())
}

/** A token word as a trade reads it: its mint, or why it can't be read, in the trade's own words. */
export function tokenOf(word: string, ctx: CommandContext): { mint: string } | { refused: string } {
  const mint = token(word, ctx)
  if (mint) return { mint }
  const said = unknown(word, ctx)
  return { refused: said.kind === "refused" ? said.message.replace(/^Not a trade yet: /, "") : unknownToken(word) }
}

/** Takes a trailing `as <agent>` and `from <wallet>` off a trade's words, in either order. */
function tradeTail(words: string[], ctx: CommandContext): { words: string[]; agent?: string; from?: string } | { refused: string } {
  let rest = words
  let agent: string | undefined
  let from: string | undefined
  for (let i = 0; i < 2 && rest.length >= 3; i++) {
    const word = rest.at(-2)!.toLowerCase()
    if (word === "as" && agent === undefined) {
      const named = asAgent(rest, ctx)
      if ("refused" in named) return named
      ;({ words: rest, agent } = named)
    } else if (word === "from" && from === undefined) {
      from = rest.at(-1)!
      rest = rest.slice(0, -2)
    } else break
  }
  return { words: rest, ...(agent ? { agent } : {}), ...(from !== undefined ? { from } : {}) }
}

/** TEE-wallet answers: in paper mode they all mean the same thing, that a TEE wallet has no paper form. */
const TEE_CODES = new Set(["TEE_TIER_REQUIRED", "TEE_WALLET_INACTIVE"])

/** `from <wallet>` on a parsed trade: the wallet it pays from (`embedded`, or the address the core hashes), or why not. */
function payFrom(command: Command, word: string, agent: string | undefined, ctx: CommandContext): Command {
  if (command.kind !== "trade") return command
  const pays = (wallet: string): Command => ({ ...command, args: { ...command.args, wallet } })
  const paper = ctx.mode === "paper"
  const noPaper = (name: string) => notTrade(`${name} is a TEE wallet, and TEE wallets have no paper form. Switch to live to pay from it, or leave out "from ${word}".`)
  // A paper trade is the key's own paper book: `embedded` is the only wallet word it takes, and needs no read.
  if (paper && word.toLowerCase() === "embedded") return pays("embedded")
  if (!agent) return notTrade("the core hasn't said which agent is active yet. Try again in a moment.")
  const mint = typeof command.args.mint === "string" ? command.args.mint : undefined
  const payer = ctx.wallets && payerContextFrom(ctx.wallets, agent, mint?.startsWith("0x") ? "hood" : undefined)
  if (!payer) return notTrade(`${agent}'s wallets haven't been read from Candle yet. Try again in a moment.`)
  // On paper either embedded address is the embedded wallet, whichever chain the token is on: the core takes it the same way.
  if (paper && (["solana", "hood"] as const).some((chain) => {
    const other = payerContextFrom(ctx.wallets!, agent, chain === "hood" ? "hood" : undefined)
    const e = other && resolvePayer(other, word)
    return e && e.ok && e.kind === "embedded"
  })) return pays("embedded")
  const r = resolvePayer(payer, word)
  if (!r.ok) return paper && TEE_CODES.has(r.code) ? noPaper(word) : notTrade(r.message)
  if (r.kind === "embedded") return pays("embedded")
  return paper ? noPaper(r.label ?? word) : pays(r.address)
}

/** Takes a trailing `as <agent>` off the words. */
function asAgent(words: string[], ctx: CommandContext): { words: string[]; agent?: string } | { refused: string } {
  if (words.length < 2 || words.at(-2)!.toLowerCase() !== "as") return { words }
  const agent = words.at(-1)!
  if (!ctx.agents.includes(agent)) return { refused: `No agent named ${agent}. Agents: ${ctx.agents.join(", ")}.` }
  return { words: words.slice(0, -2), agent }
}

export function parseCommand(input: string, ctx: CommandContext): Command | undefined {
  const line = input.trim()
  if (line === "") return undefined
  const aliases = ctx.aliases ?? new Map<string, string>()
  const raw = partsOf(line)
  if (raw.length === 0) return plain(line)
  const first = expandPart(raw[0]!, aliases)
  // One part, as typed: the line as it always was. An alias that's a whole chain is a chain.
  if (raw.length === 1 && first.length === 1) {
    const one = parseOne(first[0]!, ctx)
    // Asked of the agent, an alias's line goes as its words, which the agent can read.
    return one.kind === "refused" && one.ask && first[0] !== raw[0] ? { ...one, askText: first[0]! } : one
  }
  const lead = parseOne(first[0]!, ctx)
  if (lead.kind === "agent") {
    // English with a semicolon: to the agent whole, with an alias in its first word expanded.
    return first[0] === raw[0] ? plain(line) : plain([...first, ...raw.slice(1)].join("; "))
  }
  const parts = [...first, ...raw.slice(1).flatMap((p) => expandPart(p, aliases))]
  if (parts.length === 1) return lead
  const refuse = (message: string): Command => ({ kind: "refused", message, keepLine: true })
  if (parts.length > MAX_PARTS) return refuse(`A chain runs at most ${MAX_PARTS} parts, and this has ${parts.length}. Nothing was sent.`)
  const chain: ChainPart[] = []
  for (const [i, text] of parts.entries()) {
    const command = i === 0 ? lead : parseOne(text, ctx)
    const n = `Part ${i + 1} of ${parts.length}`
    if (command.kind === "refused") return refuse(`${n}: ${command.message} Nothing was sent.`)
    if (command.kind === "agent") return refuse(`${n} isn't a command ("${text}"): a chain's parts are trades and candle commands. To ask the agent, send it on a line of its own. Nothing was sent.`)
    if (command.kind !== "trade" && command.kind !== "cli") return refuse(`${n}: "${text}" runs on its own, not in a chain. Nothing was sent.`)
    chain.push({ command, text })
  }
  return { kind: "chain", parts: chain, echo: line }
}

/** One part of a line: a command, or English for the agent. */
function parseOne(line: string, ctx: CommandContext): Command {
  const all = line.split(/\s+/)
  const verb = all[0]!.toLowerCase()

  if (all.length === 1) {
    if (verb === "paper" || verb === "live") return { kind: "mode", mode: verb }
    if (verb === "kill") return { kind: "kill" }
    if (verb === "resume") return { kind: "resume" }
    if (verb === "resend" || verb === "abandon") return { kind: "resolve", action: verb }
    if (verb === "help" || verb === "?") return { kind: "help" }
  }
  if (verb === "forget" && all.length === 2 && all[1]!.toLowerCase() === "vault") return { kind: "forgetVault" }
  if (verb === "pnl" && all.length >= 2) {
    const window = pnlWindowWords(all.slice(1))
    if (window) return { kind: "pnlWindow", window }
  }
  if (verb === "agent" && all.length === 2) {
    return ctx.agents.includes(all[1]!) ? { kind: "setAgent", agent: all[1]! } : { kind: "refused", message: `No agent named ${all[1]}. Agents: ${ctx.agents.join(", ")}.` }
  }
  if (verb === "name") {
    const named = nameLine(line, ctx)
    if (named) return named
  }
  if (verb === "group") {
    const grouped = groupLine(all, line, ctx)
    if (grouped) return grouped
  }
  if (verb === "candle") {
    if (all.length === 1) return { kind: "refused", message: "candle needs a command, such as candle keys list." }
    const rest = asAgent(all.slice(1), ctx)
    if ("refused" in rest) return { kind: "refused", message: rest.refused }
    if (rest.words[0]?.toLowerCase() === "swap") {
      return {
        kind: "refused",
        message: "Type a swap as swap 0.1 SOL USDC, and add from <wallet> to pay from a TEE wallet: the same one-press card, run through candle swap.",
      }
    }
    return { kind: "cli", argv: rest.words, ...(rest.agent ? { agent: rest.agent } : {}) }
  }
  if (verb !== "buy" && verb !== "sell" && verb !== "swap") return plain(line)

  // "Buy $1 of ORE." as a sentence: the full stop isn't part of the token.
  const last = all.at(-1)!.replace(/[.!]+$/, "")
  if (last === "") return plain(line)
  const stripped = tradeTail([...all.slice(0, -1), last], ctx)
  if ("refused" in stripped) return { kind: "refused", message: stripped.refused }
  // "sell 50% of MOON" and "buy $25 of MOON" read as people type them.
  const words = stripped.words.filter((w, i) => !(i === stripped.words.length - 2 && w.toLowerCase() === "of"))
  if (!tradeShaped(words[1])) return plain(line)
  // Commands are exact, and a line that goes on as a sentence is for the agent ("Buy $1 of JUP (mint …),
  // then sell all of it once the buy has filled." had been refused as a malformed buy). More words than
  // any trade takes, or a sentence's punctuation, is prose; a short miss such as `sell 100% ORE` still says why.
  if (prose(line, words)) return plain(line)
  const command = tradeCommand(verb, words, line, stripped.agent, ctx)
  return stripped.from === undefined ? command : payFrom(command, stripped.from, stripped.agent ?? ctx.activeAgent, ctx)
}

/**
 * `name <wallet> <new name>`: the wallet by its address or its name now (several words, or in
 * quotes), then its new name, exactly as typed. A command only when the wallet is one the Candle Harness knows, or an
 * address; anything else ("name the wallet you'd use") is a question for the agent.
 */
function nameLine(line: string, ctx: CommandContext): Command | undefined {
  const rest = line.replace(/^\s*name\s+/i, "")
  if (rest === line) return undefined
  const names = ctx.wallets?.names ?? []
  const quoted = /^"([^"]+)"\s+(.+)$/s.exec(rest)
  if (quoted) return { kind: "name", wallet: quoted[1]!, name: quoted[2]! }
  // The longest run of words that names a wallet, so "name my exchange binance" finds "my exchange".
  const spaces = [...rest.matchAll(/\s+/g)]
  for (let k = spaces.length - 1; k >= 0; k--) {
    const at = spaces[k]!
    const wallet = rest.slice(0, at.index)
    const name = rest.slice(at.index! + at[0].length)
    if (name !== "" && (lookupWallet(names, wallet).kind !== "none" || (k === 0 && isAddressShaped(wallet)))) return { kind: "name", wallet, name }
  }
  return undefined
}

const GROUP_VERBS = new Set(["add", "remove", "prefix", "delete"])

/**
 * `group <name> <verb> …`: a command only when its third word is add, remove, prefix or
 * delete; anything else ("group my wallets by agent") is a question for the agent. The wallets after add or
 * remove are one wallet's name (several words), or a list split by commas, else by spaces. The core checks
 * the rest (a group's name, each wallet, the prefix) and says why in its own words.
 */
function groupLine(all: readonly string[], line: string, ctx: CommandContext): Command | undefined {
  const verb = all[2]?.toLowerCase()
  if (all.length < 3 || verb === undefined || !GROUP_VERBS.has(verb)) return undefined
  const group = all[1]!
  const rest = line.trim().split(/\s+/).slice(3).join(" ").trim()
  const refuse = (message: string): Command => ({ kind: "refused", message, keepLine: true })
  if (verb === "delete") return all.length === 3 ? { kind: "group", op: { op: "delete", group } } : refuse(`group ${group} delete takes nothing after it.`)
  if (verb === "prefix") {
    if (rest === "") return refuse(`Name the start of the wallets' names: group ${group} prefix bot-, or prefix none to drop it.`)
    return { kind: "group", op: { op: "prefix", group, prefix: rest.toLowerCase() === "none" ? null : rest } }
  }
  if (rest === "") return refuse(`Name a wallet: group ${group} ${verb} <wallet>, or several split by commas.`)
  const one = lookupWallet(ctx.wallets?.names ?? [], rest).kind !== "none"
  const wallets = one ? [rest] : rest.includes(",") ? rest.split(",").map((w) => w.trim()).filter(Boolean) : rest.split(/\s+/)
  return { kind: "group", op: { op: verb as "add" | "remove", group, wallets } }
}

/**
 * The words after `pnl`, as a window: `24h`, `midnight` or `today`, `session` or `last session`, or a time of
 * day, each after an optional `since`. Anything else is a question for the agent ("pnl since Tuesday?").
 */
function pnlWindowWords(words: string[]): PnlWindow | undefined {
  const rest = (words[0]?.toLowerCase() === "since" ? words.slice(1) : words).join(" ").toLowerCase()
  const named: Record<string, PnlWindow> = { today: "midnight", "last session": "session", "last 24h": "24h", "24 hours": "24h", "the last 24 hours": "24h" }
  if (named[rest]) return named[rest]
  const parsed = parseWindow(rest)
  return parsed.ok ? parsed.window : undefined
}

/** A trade-shaped line, less its `as` and `from`: the trade, or why it can't run as typed. */
function tradeCommand(verb: "buy" | "sell" | "swap", words: string[], line: string, named: string | undefined, ctx: CommandContext): Command {
  const agent = named ? { agent: named } : {}
  if (verb === "buy") {
    // buy $25 MOON
    if (words[1]!.startsWith("$")) {
      const dollars = DOLLARS.exec(words[1]!)
      if (!dollars) return notTrade("dollars are a number with at most two decimals, such as buy $25 MOON.")
      if (words.length !== 3) return notTrade("buy dollars of one token, such as buy $25 MOON.")
      const mint = token(words[2]!, ctx)
      if (!mint) return unknown(words[2]!, ctx)
      return { kind: "trade", tool: "candle_trade", args: { mint, side: "buy", amountUsd: dollars[1] }, ...agent, echo: line }
    }
    // buy 0.1 sol MOON
    if (!AMOUNT.test(words[1]!)) return notTrade("buy an amount, such as buy 0.1 sol MOON or buy $25 MOON.")
    if (words.length !== 4 || !SPEND.has(words[2]!.toLowerCase())) return notTrade("say what pays: SOL, USDC or CNDL, such as buy 0.1 sol MOON, or buy dollars, such as buy $25 MOON.")
    const mint = token(words[3]!, ctx)
    if (!mint) return unknown(words[3]!, ctx)
    return { kind: "trade", tool: "candle_trade", args: { mint, side: "buy", amount: words[1], quoteAsset: words[2]!.toLowerCase() }, ...agent, echo: line }
  }

  if (verb === "sell") {
    // sell 50% MOON, sell 1000 MOON
    if (words.length !== 3) return notTrade("sell a percent or an amount of one token, such as sell 50% MOON.")
    const percent = PERCENT.exec(words[1]!)
    if (!percent && !AMOUNT.test(words[1]!)) return notTrade("sell a percent or an amount, such as sell 50% MOON.")
    const mint = token(words[2]!, ctx)
    if (!mint) return unknown(words[2]!, ctx)
    if (percent) {
      const n = Number(percent[1])
      if (n < 1 || n > 100) return { kind: "refused", message: "Sell a percent from 1% to 100%." }
      return { kind: "trade", tool: "candle_trade", args: { mint, side: "sell", percent: n }, ...agent, echo: line }
    }
    return { kind: "trade", tool: "candle_trade", args: { mint, side: "sell", amount: words[1] }, ...agent, echo: line }
  }

  // swap 0.1 SOL USDC: between base assets only; a token goes through buy or sell.
  if (!AMOUNT.test(words[1]!) || words.length !== 4) return notTrade("swap an amount between two base assets, such as swap 0.1 SOL USDC.")
  const from = words[2]!.toUpperCase()
  const to = words[3]!.toUpperCase()
  if (!BASE.has(from) || !BASE.has(to)) return notTrade(`swap is between ${[...BASE].join(", ")}. A token is bought or sold: buy 0.1 sol MOON, sell 50% MOON.`)
  if (from === to) return { kind: "refused", message: "A swap needs two different assets." }
  return { kind: "trade", tool: "candle_swap", args: { from, to, amount: words[1] }, ...agent, echo: line }
}

/**
 * Every kind of line the input line takes: what `?` shows (`form` and `help`), and what the
 * docs' typed-commands page adds beside it, an example and a sentence. One table, so the page and `?` never
 * differ; scripts/docs-pages.test.ts fails on a kind of command with no row, and runs every example.
 */
export interface TypedRow {
  form: string
  /** `?`'s words, after the form. */
  help: string
  /** A line as typed, which parses to one of `kinds`. */
  example: string
  /** The docs' sentence. */
  words: string
  kinds: readonly Command["kind"][]
}

export const TYPED_ROWS: readonly TypedRow[] = [
  {
    form: "buy 0.1 sol MOON",
    help: "buy with SOL, USDC or CNDL",
    example: "buy 0.5 usdc of MOON",
    words: "Buys a token with an amount of SOL, USDC or CNDL. The token is its mint, or a name a pane or the agent has shown this session; a name nobody has shown is never guessed.",
    kinds: ["trade"],
  },
  {
    form: "buy $25 MOON",
    help: "buy 25 dollars' worth, in the spend asset",
    example: "buy $5 of MOON",
    words: "Buys a dollar amount of a token, converted when the card is made into what it spends: SOL, unless config.toml's `trade.spendAsset` says otherwise.",
    kinds: ["trade"],
  },
  {
    form: "sell 50% MOON",
    help: "or sell 1000 MOON",
    example: "sell 100% of MOON",
    words: "Sells a percent of what the wallet holds of a token, from 1% to 100%, or an amount of it, such as `sell 1000 MOON`.",
    kinds: ["trade"],
  },
  {
    form: "swap 0.1 SOL USDC",
    help: "between base assets",
    example: "swap 25 USDC SOL",
    words: "Swaps an amount between two base assets: SOL, USDC, CNDL, ETH or USDG. A token is bought or sold instead.",
    kinds: ["trade"],
  },
  {
    form: "… as <agent>",
    help: "with another agent's key",
    example: "buy $25 MOON as agent-b",
    words: "Runs a trade or a `candle` command as another agent, with its key and limits, rather than the active agent's.",
    kinds: ["trade"],
  },
  {
    form: "… from <wallet>",
    help: "pay from a wallet by its name or address, or embedded",
    example: "buy $25 MOON from embedded",
    words: "Pays from a wallet by its name or address, or `embedded` for the account's embedded wallet. A wallet the agent can't pay from is refused, saying why, before anything is sent.",
    kinds: ["trade"],
  },
  {
    form: "paper · live",
    help: "switch modes (live asks first)",
    example: "live",
    words: "Switches between paper trades, which are recorded at the quoted price and never sent, and live trades, which move real funds. Switching to live asks first.",
    kinds: ["mode"],
  },
  {
    form: "kill · resume",
    help: "the kill switch (or ctrl-x twice)",
    example: "kill",
    words: "The kill switch: buys pause, the agent stops, buy and swap cards are withdrawn, and each open sell gets a fresh card. `resume` turns buys back on.",
    kinds: ["kill", "resume"],
  },
  {
    form: "resend · abandon",
    help: "a trade Candle didn't answer (or click it)",
    example: "resend",
    words: "For a trade Candle didn't answer: `resend` sends it again under the same id where the tool has one, so it never runs twice (a post, a fee claim, a profile edit or an upload has none, and says so); `abandon` lets it go. Or click the trade in the agent pane.",
    kinds: ["resolve"],
  },
  {
    form: "agent <name>",
    help: "make another agent the active one",
    example: "agent agent-b",
    words: "Makes another agent the active one: the agent your messages and typed lines go to.",
    kinds: ["setAgent"],
  },
  {
    form: "pnl since 18:00",
    help: "the P&L window: 24h, midnight, a time, or last session",
    example: "pnl since last session",
    words: "Sets the window every P&L figure is measured over: `pnl 24h`, `pnl since midnight`, a time of day, or `pnl since last session`.",
    kinds: ["pnlWindow"],
  },
  {
    form: "name <wallet> <name>",
    help: "name a wallet: Candle's or the vault's in the pane, the Candle Harness's at once",
    example: "name Fk3eQ9mW2vT8rYp5LxN7cZ1bH4jS6dGuAa8KqRwEs2Vn main",
    words: "Names a wallet, by its address or the name it has now. A TEE wallet's name is Candle's and a vault key's is the vault's, so those are renamed in the prompt pane; the Candle Harness's own names change at once.",
    kinds: ["name"],
  },
  {
    form: "group <g> add <wallet>",
    help: "a wallet group: add, remove, prefix bot- (or none), delete",
    example: "group bots prefix bot-",
    words: "Makes or changes a wallet group: `add` or `remove` wallets by name or address, `prefix bot-` to take every wallet whose name starts with it (`prefix none` drops it), or `delete`. A group organises wallets; it never pays.",
    kinds: ["group"],
  },
  {
    form: "forget vault",
    help: "this machine's vault is gone on purpose",
    example: "forget vault",
    words: "Tells the Candle Harness the vault on this machine was removed on purpose, so owner steps run without the factor again. The Candle Harness checks there's no vault first.",
    kinds: ["forgetVault"],
  },
  {
    form: "candle <command>",
    help: "any Candle CLI command, under its rule",
    example: "candle keys list",
    words: "Runs any of Candle's CLI commands under its rule: a read at once, the rest as a card or in the prompt pane.",
    kinds: ["cli"],
  },
  {
    form: "… ; …",
    help: "a chain: up to 5 trades or candle commands, each after the one before ends",
    example: "buy $1 of MOON; sell 100% of MOON",
    words: "Up to 5 trades or `candle` commands, split by semicolons. Every part is checked before anything is sent, then each runs once the one before has ended; one that fails stops the rest.",
    kinds: ["chain"],
  },
  {
    form: "<alias> …",
    help: "an alias from config.toml's [aliases], such as b5 = \"buy $5 of\"",
    example: "b5 MOON",
    words: "An alias from config.toml's `[aliases]` stands for the start of a line: with `b5 = \"buy $5 of\"`, `b5 MOON` buys $5 of MOON.",
    kinds: ["trade"],
  },
  {
    form: "help · ?",
    help: "this list, and every key",
    example: "help",
    words: "Lists what you can type and every key. `?` with the line empty opens it too.",
    kinds: ["help"],
  },
  {
    form: "anything else",
    help: "goes to the agent",
    example: "what's moving on Solana right now?",
    words: "Goes to the agent as a message. A line shaped like a trade that can't run as typed says why instead, and sends nothing.",
    kinds: ["agent"],
  },
]
