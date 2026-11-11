// Owner rows: what an owner card says before it runs, and what's offered once it
// ends. Pure: the CLI tool and the core read what these need and pass it in.
//
// The core never changes an existing key or binding by itself. A step that follows
// another (a key made but not stored, the LP agent's fresh TEE wallet, a rebind that left an agent
// with none) is offered as a chip that puts the exact command on the input line, where the user
// reads it and presses Enter; a typed owner row opens the pane at once.
import { isAgentName } from "../paths"
import { isEvmAddress } from "../shared/chains"
import { terminalText } from "../shared/terminal-text"
import { type CliRule, isFlagWord, LP_AGENT_SCOPES, type Preset, SOURCE, sourceForWords } from "./cli-table"

/**
 * Whether a call runs in the prompt pane now, by its rule and route as its flags make them (`tee status
 * --verify` is an owner row, `vault status --unlock` a ceremony): an owner row, a ceremony, or funds out.
 */
export function paneRowNow(rule: CliRule, route: string): boolean {
  return (rule === "owner" || rule === "ceremony" || rule === "funds-out") && route === "pane"
}

/**
 * Paused, the kill switch withdraws `vault transfer`, which sends to any address, and refuses new ones.
 * It keeps `tee sweep` and `external sweep`: they bring funds home. (`vault fund` is an owner row, in
 * OWNER_STOPS; `vault demote` is a way home, kept.)
 */
export const FUNDS_OUT_STOPS: ReadonlySet<string> = new Set(["vault transfer"])

/**
 * Paused, the kill switch withdraws these ceremonies and refuses new ones: `wallets import`, which adds a
 * wallet the agent's key can spend from, and a `sign` or `sign message` with `--broadcast`, which sends
 * what it signed. The others spend nothing and widen nothing.
 */
export function ceremonyStops(row: string, words: readonly string[] | undefined): boolean {
  if (row === "wallets import") return true
  return (row === "sign" || row === "sign message") && (words?.includes("--broadcast") ?? false)
}

/**
 * Paused, the kill switch withdraws the owner cards that widen access or spend, and refuses new ones. It
 * keeps `vault demote` (a way home) and the rest. Narrowing rows are less-access cards, never owner ones,
 * so `keys access` and `keys update` here are always the widening forms.
 */
export const OWNER_STOPS: ReadonlySet<string> = new Set([
  "keys create",
  // Raising or clearing a key's Candle cap widens what it may spend (0.13.5).
  "keys limit",
  // A plan payment spends from a vault key; auto-renew on lets later commands pay unattended (0.13.9).
  "plan buy",
  "plan renew",
  "plan auto-renew on",
  "keys access",
  "keys update",
  "wallets trust",
  "wallets allow-launch",
  "tee rebind",
  "tee enable",
  "vault promote",
  "vault promote-batch",
  "vault fund",
])

/** On every owner card in paper mode: owner rows act on the account whatever the mode. */
export const REAL_IN_PAPER = "Real, whatever the mode: owner steps act on your account."

/** A chip that puts a command on the input line: the user reads it, then presses Enter. */
export interface Fill {
  label: string
  line: string
  /** Where the cursor waits on the line, where the person types a value in the middle (a bridge's amount); else its end. */
  cursor?: number
}

/** A next step that copies a value rather than typing a line: a wallet's address, to send funds to. */
export interface CopyStep {
  label: string
  copy: string
}

/** What a finished step offers next: lines to send, or a value to copy. */
export type NextStep = Fill | CopyStep

const flagValue = (words: readonly string[], flag: string): string | undefined => {
  const at = words.indexOf(flag)
  return at >= 0 ? words[at + 1] : undefined
}

/** The positionals after `candle <command> <subcommand>`: words that aren't flags or a flag's value. */
export function positionals(words: readonly string[], valueFlags: readonly string[]): string[] {
  const entry = sourceForWords(words)
  const out: string[] = []
  for (let i = 2; i < words.length; i++) {
    const w = words[i]!
    if (isFlagWord(entry, w)) {
      if (valueFlags.includes(w)) i++
      continue
    }
    out.push(w)
  }
  return out
}

/** `--access` spellings `keys create` takes (cli/src/commands/keys.ts, CREATE_ACCESS_LEVELS), to the preset each mints. */
const ACCESS: Record<string, keyof typeof SOURCE.presets> = {
  read: "read",
  write: "readwrite",
  "read-write": "readwrite",
  withdraw: "readwritetransfer",
  transfer: "readwritetransfer",
  "read-write-transfer": "readwritetransfer",
  "trade-perps": "tradeperps",
}

const MOVES_FUNDS = ["transfer:write", "transfer:bound"]

/** How often a key's Candle cap resets, as `keys create --reset` takes it. */
const RESETS = ["daily", "weekly", "monthly", "never"]

/** The preset a scope list is exactly, if any. */
export function presetOf(scopes: readonly string[]): Preset | undefined {
  const key = (list: readonly string[]) => [...list].sort().join(",")
  return Object.values(SOURCE.presets).find((p) => key(p.scopes) === key(scopes))
}

export type KeysCreate =
  | { ok: true; words: string[]; newAgent: string; lp: boolean; notes: string[] }
  | { ok: false; code: string; message: string }

/**
 * `keys create` as the Candle Harness runs it: the key goes straight into the Candle Harness as a new agent
 * named by `--label`, so the label must be a free agent name. Write when neither `--access` nor
 * `--scopes` says (the core adds `--access write`, so the card and the hash show it). Never a key that
 * moves funds, and never `--embedded-wallet allow`, whose own confirm needs the
 * terminal the key's JSON is piped from: that's a second owner step, `keys update`.
 */
export function prepareKeysCreate(words: readonly string[], ctx: { configured: ReadonlySet<string>; maxAgents: number }): KeysCreate {
  const fail = (code: string, message: string): KeysCreate => ({ ok: false, code, message: `${message} Nothing was run.` })
  const name = flagValue(words, "--label")
  if (name === undefined) return fail("NAME_THE_AGENT", "Name the new agent with --label <name>: the key goes straight into the Candle Harness as that agent.")
  if (!isAgentName(name)) return fail("BAD_AGENT_NAME", `"${terminalText(name, { maxLength: 40 })}" can't be an agent's name: use 1 to 32 lower-case letters, digits, "-" or "_".`)
  if (ctx.configured.has(name)) return fail("AGENT_EXISTS", `${name} is already an agent in the Candle Harness. Pick another name; the Candle Harness never replaces a key.`)
  if (ctx.configured.size >= ctx.maxAgents) return fail("TOO_MANY_AGENTS", `The Candle Harness already has ${ctx.maxAgents} agents, Candle's limit of active keys per account.`)
  if (flagValue(words, "--embedded-wallet") === "allow") {
    return fail("ALLOW_AFTER", `Make the key with the embedded wallet denied, then allow it with candle keys update <prefix> --embedded-wallet allow, a second owner step: the CLI asks you to type the key's prefix for it.`)
  }
  // The values the card's words and the line its chip types are made of, checked as the CLI checks them
  // (args.ts: parseUsdToMicros, TX_LIMIT_RESETS, parseExpiresInDays).
  const limitWord = flagValue(words, "--tx-limit")
  if (limitWord !== undefined && !(/^\$?\d[\d,]*(\.\d+)?$/.test(limitWord) && Number(limitWord.replace(/^\$/, "").replace(/,/g, "")) > 0)) {
    return fail("BAD_TX_LIMIT", "--tx-limit is a dollar amount above $0, such as 25.")
  }
  const resetWord = flagValue(words, "--reset")
  if (resetWord !== undefined && !RESETS.includes(resetWord)) return fail("BAD_RESET", `--reset is ${RESETS.join(", ")}.`)
  const expires = flagValue(words, "--expires-in")
  if (expires !== undefined && !/^[1-9]\d{0,5}$/.test(expires)) return fail("BAD_EXPIRES_IN", "--expires-in is a whole number of days, such as 30.")
  const embedded = flagValue(words, "--embedded-wallet")
  if (embedded !== undefined && embedded !== "deny") return fail("BAD_EMBEDDED_WALLET", "--embedded-wallet is deny, or left out.")
  const access = flagValue(words, "--access")
  const scopesFlag = flagValue(words, "--scopes")
  if (access !== undefined && ACCESS[access] === undefined) return fail("BAD_ACCESS", `--access is read, write or trade-perps.`)
  const scopes = scopesFlag !== undefined ? scopesFlag.split(",").map((s) => s.trim()).filter(Boolean) : SOURCE.presets[ACCESS[access ?? "write"]!].scopes
  if (scopes.some((s) => MOVES_FUNDS.includes(s))) {
    return fail("NO_WITHDRAW_KEY", "A key that can move funds out never lives in the Candle Harness. Make it in your own terminal or Candle's console.")
  }
  const out = [...words]
  if (access === undefined && scopesFlag === undefined) out.push("--access", "write")
  const lp = scopes.includes("lp:write")
  const preset = presetOf(scopes)
  const accessWords = preset ? `${preset.label} access` : `scopes ${scopes.join(", ")}`
  const limit = flagValue(words, "--tx-limit")
  const cap = limit !== undefined ? `a Candle cap of $${limit} ${flagValue(words, "--reset") ?? "daily"}` : "no Candle cap"
  const notes = [
    `New agent ${name}: ${accessWords}, ${cap}, the embedded wallet denied.`,
    "No copy of the key is shown: it goes straight into the Candle Harness. Candle's console can mint another.",
  ]
  if (lp || !preset) notes.push(`Not a preset: changing this key's access with a preset later removes ${lp ? "LP" : scopes.filter((s) => !SOURCE.presets.readwrite.scopes.includes(s)).join(", ") || "these scopes"}.`)
  if (lp) notes.push(`Then a fresh TEE wallet from your vault for ${name}, promoted to its key and funded, each its own step. Nothing of any other agent's is touched.`)
  return { ok: true, words: out, newAgent: name, lp, notes }
}

/** Whether a `keys create` asks for LP: Write's scopes plus `lp:write`. */
export const isLpScopes = (scopes: readonly string[]) => scopes.includes("lp:write")
export { LP_AGENT_SCOPES }

/**
 * What a preset drops from a key whose scopes aren't one: "removes LP" on a `keys
 * access` card for the LP agent's key.
 */
export function presetDrops(current: readonly string[], to: string | undefined): string | undefined {
  if (presetOf(current)) return undefined
  const target = to !== undefined && ACCESS[to] ? SOURCE.presets[ACCESS[to]!].scopes : []
  const dropped = current.filter((s) => !target.includes(s))
  if (dropped.length === 0) return undefined
  const named = dropped.includes("lp:write") ? "LP" : dropped.join(", ")
  return `This key's access isn't a preset: setting it to ${to ?? "a preset"} removes ${named} (${dropped.join(", ")}).`
}

/**
 * The vault label an agent's fresh TEE wallet gets: `<agent>-tee`, or the first `<agent>-tee-2`, `-3`… that no wallet the
 * Candle Harness knows is named, compared without case as names are. The CLI refuses a label the vault holds, and a second wallet
 * of its own for the same agent (a bot's) is the usual case.
 */
export function teeLabelFor(agent: string, taken: readonly string[] = []): string {
  return walletLabelFor(agent, "tee", taken)
}

/** `<agent>-<ending>`, or the first `<agent>-<ending>-2`, `-3`… that no name the Candle Harness knows holds, without case. */
export function walletLabelFor(agent: string, ending: string, taken: readonly string[] = []): string {
  const held = new Set(taken.map((n) => n.normalize("NFKC").toLowerCase()))
  const base = `${agent}-${ending}`
  if (!held.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!held.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`
}

/** What the Hood chip is called, wherever it shows. */
export const ADD_HOOD_WALLET = "add a Hood wallet"

/**
 * How `vault promote --to-key` names an agent's key. Its prefix, unless that starts with "-": `vault promote` reads
 * such a value as a missing one (unlike `tee rebind`), so the key goes by its label, the agent's name that setup gives
 * it. The CLI refuses a label two keys share, so the wrong key is never reached.
 */
export const promoteTarget = (agent: string, prefix: string): string => (prefix.startsWith("-") ? agent : prefix)

/**
 * The next step to an agent's own Hood TEE wallet, as the chip types it for the person to send: a vault where this
 * machine has none; an EVM vault key where the vault has none (a new one holds nothing, and the funding comes after);
 * then the promote from that key to the agent's key, which makes the wallet and pins it to the key, its sweep home.
 * With several EVM vault keys, the person names the one, typed last. Nothing is made unless the person sends it.
 */
export function hoodWalletStep(agent: string, ctx: { prefix: string; vault: boolean; evmKeys: readonly string[]; taken?: readonly string[] }): Fill {
  if (!ctx.vault) return { label: ADD_HOOD_WALLET, line: "candle vault init" }
  if (ctx.evmKeys.length === 0) return { label: ADD_HOOD_WALLET, line: `candle vault new-key --chain evm --label ${walletLabelFor(agent, "hood-key", ctx.taken)}` }
  const from = ctx.evmKeys.length === 1 ? ctx.evmKeys[0]! : ""
  return { label: ADD_HOOD_WALLET, line: `candle vault promote --to-key ${promoteTarget(agent, ctx.prefix)} --label ${walletLabelFor(agent, "hood", ctx.taken)} --from ${from}` }
}

/**
 * A fresh Hood TEE wallet's funding, ETH first: it can't trade, or be swept, without ETH for gas and its reserve. A
 * bridge landing ETH from the same key's Solana TEE wallet (the one the key holds; a bridge lands only in the key's own
 * wallet on the other chain), with the amount typed where the cursor waits; the fund line from its pinned EVM vault key,
 * which starts empty; or its address, to send ETH to from anywhere.
 */
export function hoodFundSteps(agent: string, ctx: { address?: string; solanaTee?: string }): NextStep[] {
  const steps: NextStep[] = []
  if (ctx.address !== undefined && ctx.solanaTee !== undefined) {
    // It names where it lands: the key may hold another Hood TEE wallet, and a bridge never guesses between them.
    steps.push({ label: "bridge ETH", line: `bridge  sol to eth from ${ctx.solanaTee} into ${ctx.address} as ${agent}`, cursor: "bridge ".length })
  }
  steps.push({ label: "fund from vault key", line: `candle vault fund ${ctx.address ?? "<its address>"} --asset ETH --amount ` })
  if (ctx.address !== undefined) steps.push({ label: "⧉ address", copy: ctx.address })
  return steps
}

/**
 * A new EVM vault key the Hood chip named for an agent (`<agent>-hood-key`, or one of its numbered ones), one key at a
 * time: what follows is that agent's promote from it.
 */
export function hoodNewKeyOf(words: readonly string[], agents: ReadonlyMap<string, string>): { agent: string; key: string } | undefined {
  const [command, sub] = words
  if (command !== "vault" || sub !== "new-key" || flagValue(words, "--chain") !== "evm" || words.includes("--count") || words.includes("--labels-from")) return undefined
  const key = flagValue(words, "--label")
  if (key === undefined) return undefined
  for (const agent of agents.keys()) if (new RegExp(`^${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-hood-key(-\\d+)?$`, "i").test(key)) return { agent, key }
  return undefined
}

/**
 * A fresh TEE wallet for an agent, never a rebind of another's, one step at a time, each typed by the user from a chip:
 *   1. promoted from a vault key to the agent's key, by prefix: the CLI makes the wallet and pins it to
 *      that vault key, its sweep home;
 *   2. funded from that same vault key (`vault fund` sends only from a TEE wallet's pinned vault key),
 *      at an amount the user types last.
 * The promotion never makes a new vault key, which would leave the funding nothing to send. The
 * vault key is filled in when the Candle Harness knows just one (from `candle vault list`); else the user types it.
 */
export function freshTeeStep(step: 1 | 2, agent: string, ctx: { prefix: string; vaultKey?: string; address?: string; taken?: readonly string[] }): Fill {
  switch (step) {
    case 1:
      return { label: `new TEE wallet for ${agent}`, line: `candle vault promote --to-key ${promoteTarget(agent, ctx.prefix)} --label ${teeLabelFor(agent, ctx.taken)} --from ${ctx.vaultKey ?? ""}` }
    case 2:
      return { label: `fund ${agent}'s TEE wallet`, line: `candle vault fund ${ctx.address ?? "<its address>"} --asset ${ctx.address !== undefined && isEvmAddress(ctx.address) ? "ETH" : "SOL"} --amount ` }
  }
}

/** A promote to an agent's key, however it was typed: its next step is funding the wallet it made. */
export function freshTeeStepOf(words: readonly string[], agents: ReadonlyMap<string, string>): { agent: string; label?: string } | undefined {
  const [command, sub] = words
  if (command !== "vault" || sub !== "promote") return undefined
  const to = flagValue(words, "--to-key")
  const label = flagValue(words, "--label")
  for (const [agent, prefix] of agents) if (to === prefix || (to !== undefined && to === promoteTarget(agent, prefix))) return { agent, ...(label !== undefined ? { label } : {}) }
  return undefined
}

/** The rebind's card line: what moves, and that nobody's key changes. */
export function rebindNote(moving: { name: string; from?: string }[], to: string | undefined): string {
  const what = moving.map((w) => (w.from ? `${w.from}'s TEE wallet ${w.name}` : `TEE wallet ${w.name}`)).join(", ")
  const keeps = [...new Set(moving.flatMap((w) => (w.from ? [w.from] : [])))]
  return `${what || "These TEE wallets"} will move to ${to ?? "the key you named"}${keeps.length ? `; ${keeps.join(" and ")} ${keeps.length === 1 ? "keeps its" : "keep their"} key` : ""}. The funds don't move.`
}

/**
 * After a rebind the user asked for: each agent it left with no TEE wallet, what it can still trade
 * from, and a fresh TEE wallet offered.
 */
export function rebindLeft(holders: readonly string[], ctx: { teeCount: (agent: string) => number; embedded: (agent: string) => "allowed" | "denied" | undefined; prefix: (agent: string) => string | undefined; vaultKey?: string; taken?: readonly string[] }): { words: string[]; next: Fill[] } {
  const left = holders.filter((a) => ctx.prefix(a) !== undefined && ctx.teeCount(a) === 0)
  return {
    words: left.map((a) => `${a} has no TEE wallet now${ctx.embedded(a) === "denied" ? ", and its key isn't allowed the embedded wallet, so it can't trade until it has one" : "; it can still trade from the embedded wallet"}.`),
    next: left.map((a) => freshTeeStep(1, a, { prefix: ctx.prefix(a)!, ...(ctx.vaultKey ? { vaultKey: ctx.vaultKey } : {}), ...(ctx.taken ? { taken: ctx.taken } : {}) })),
  }
}

/** The rebind chips under a revoke's stranding warning: each TEE wallet it would strand, onto another agent's key. */
export function rebindFills(stranded: readonly { address: string }[], others: ReadonlyMap<string, string>): Fill[] {
  if (stranded.length === 0) return []
  const wallets = stranded.map((w) => w.address).join(" ")
  return [...others].slice(0, 3).map(([agent, prefix]) => ({ label: `rebind to ${agent}`, line: `candle tee rebind ${wallets} --to-key ${prefix}` }))
}
