// candle_cli: the agent's route to every CLI command (whatever the CLI can do, the agent can ask for), run by the core under each
// row's rule (cli-table.ts). Reads run at once; narrowing access is a one-press card from the agent,
// and runs at once when the user types it. The CLI's card rows (a TEE wallet's staking, image uploads;
// LP, a TEE wallet's launch and closing empty accounts held "coming" until each is checked live) are
// one-press cards from the agent and when typed (cli-cards.ts). A row that asks at the CLI's own prompt
// runs in the prompt pane: from the agent a one-press card, then the pane; typed, the pane at once (a
// card inside, approved as "typed"). Funds out go only by the owner's vault-signed routes and the
// destination checks (destinations.ts): from the agent only when the user asked this turn, and typed, a
// new address is a card and a click. Everything else says what holds it, or that it comes later.
//
// The runner refuses: a command or subcommand the table doesn't have; any flag not on the row's
// allowlist (who or where it runs, paths, `--yes`, `--rpc-url`: the core adds those where allowed);
// a `--flag=value` form; a positional path; an argument that's really a second command; more than 64
// arguments or 4 KiB.
import { canonicalJson } from "../shared/canonical-json"
import { isEvmAddress } from "../shared/chains"
import type { Redactor } from "../shared/redact"
import { refused } from "../shared/rpc"
import { terminalText } from "../shared/terminal-text"
import { type CandleCli, type CliResult, rpcToEnv } from "./candle-cli"
import type { CliCardRequest, CliCards } from "./cli-cards"
import type { CardKind } from "./classify"
import { type Destination, notAsked, prepareFundsOut } from "./destinations"
import { versionAtLeast } from "./candle-mcp"
import { allowedFlags, CLI_ROWS, type CliRow, canonicalCommand, LP_AGENT_SCOPES, type CliRule, dashPrefixValue, type Identity, isFlagWord, MIN_CANDLE_CLI, type Route, needsVault, repeats, rowFor, runsInPane, SOURCE, type SourceEntry, sourceFor } from "./cli-table"
import type { Mapped, Operation } from "./execute"
import type { Journal } from "./journal"
import { paneRowNow, positionals, prepareKeysCreate, presetDrops, REAL_IN_PAPER, rebindFills, rebindNote } from "./owner-rows"
import type { PaneRequest } from "./pane-plan"
import { type CardDesk, cardAnswer, type CardView, type FaceClient, type ToolResult } from "./tool-face"
import { VAULT_GONE } from "./vault-mark"
import { short, walletName } from "./wallet-names"
import { type RenewDue, renewWarning } from "./plan-renew"

const MAX_ARGS = 64
const MAX_ARG_BYTES = 4096
const MAX_OUTPUT = 64 * 1024
const MAX_STDERR = 4 * 1024
/** A refusal's words in the journal: the agent's record and Activity show them. */
const MAX_REFUSAL = 400
const SECOND_COMMAND = new Set([";", "&&", "||", "|", "&"])
const WORD = /^[a-z][a-z-]{0,31}$/
/** A word the input line reads back as one word: no space, ";" or control character. */
const PLAIN_WORD = /^[^\s;\p{C}]+$/u
/** `candle swap` is the TEE route's runner, reached by one parser and one card path. */
const SWAP_FOR_AGENT = "Use candle_trade or candle_swap with wallet set to the TEE wallet's label or address, or candle_bridge for SOL or USDC to ETH or USDG (or back): the Candle Harness runs candle swap for you, on a one-press card."
const SWAP_TYPED = "Type buy, sell, swap or bridge … from <wallet> instead: the Candle Harness runs candle swap for you, on a one-press card. Nothing was run."

export interface ResolvedCall {
  row: CliRow
  rule: CliRule
  route: Route
  identity: Identity
  /** The agent whose key it runs with, for identity `agent`. */
  agent?: string
  /** What runs, after `candle`, with every flag the core adds. */
  argv: string[]
  json: boolean
  withRpcUrl: boolean
  /** Whether the command takes `--yes`. */
  takesYes: boolean
  /** The value flags the command takes, as its source declares them. */
  valueFlags: string[]
}

type Resolution = { ok: true; call: ResolvedCall } | { ok: false; code: string; message: string }

const fail = (code: string, message: string): Resolution => ({ ok: false, code, message })

/** Checks a call against the table and the row's allowlist. Pure: nothing runs. */
export function resolveCall(input: { command: unknown; subcommand?: unknown; args?: unknown; agent?: unknown }, ctx: { defaultAgent: string; agents: ReadonlySet<string> }): Resolution {
  // `wallet` is the CLI's alias for `wallets`: resolved as the CLI resolves it, before the table.
  const command = typeof input.command === "string" ? canonicalCommand(input.command) : input.command
  const subcommand = input.subcommand ?? null
  const args = input.args ?? []
  if (typeof command !== "string" || !WORD.test(command)) return fail("NOT_IN_MAP", "command must be one of the candle CLI's command words, such as keys.")
  if (subcommand !== null && (typeof subcommand !== "string" || !WORD.test(subcommand))) return fail("NOT_IN_MAP", "subcommand must be a word, such as revoke.")
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return fail("BAD_ARGS", "args must be a list of strings.")
  if (args.length > MAX_ARGS) return fail("BAD_ARGS", `At most ${MAX_ARGS} arguments.`)
  if (Buffer.byteLength(args.join("\0"), "utf8") > MAX_ARG_BYTES) return fail("BAD_ARGS", "The arguments are over 4 KiB.")
  for (const arg of args as string[]) {
    if (/[\n\r\0]/.test(arg)) return fail("BAD_ARGS", "An argument can't hold a newline or NUL.")
    if (SECOND_COMMAND.has(arg.trim())) return fail("BAD_ARGS", `"${arg}" would start a second command; candle_cli runs one command, with no shell.`)
  }

  const entry = sourceFor(command, subcommand as string | null)
  if (!entry) {
    const subs = SOURCE.commands.filter((c) => c.command === command && c.subcommand !== null).map((c) => c.subcommand)
    // On a newer CLI a command the table doesn't hold is refused, naming the CLI it was checked against.
    const checked = `candle ${SOURCE.source.cliVersion}, the CLI the Candle Harness was checked against`
    if (subs.length > 0) return fail("NOT_IN_MAP", `candle ${command} ${subcommand ?? ""}`.trim() + ` isn't a command in ${checked}. Its subcommands: ${subs.join(", ")}.`)
    // `help keys` with keys as the subcommand: the topic is help's argument.
    if (subcommand !== null && sourceFor(command, null)) return fail("NOT_IN_MAP", `candle ${command} has no subcommands: pass "${subcommand}" in args instead (candle ${command} ${subcommand}).`)
    return fail("NOT_IN_MAP", `candle ${command} isn't a command in ${checked}.`)
  }
  const base = subcommand === null ? command : `${command} ${subcommand}`
  let rest = [...(args as string[])]
  const action = rest[0] !== undefined && !rest[0].startsWith("-") ? rowFor(`${base} ${rest[0]}`) : undefined
  const row = action ?? rowFor(base)
  if (!row) return fail("NOT_IN_MAP", `candle ${base} isn't in the Candle Harness's map yet.`)
  const head = action ? [rest.shift()!] : []

  const allowed = allowedFlags(entry, head[0], row.pane?.lifts)
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!isFlagWord(entry, arg)) {
      positionals.push(arg)
      continue
    }
    if (arg.includes("=")) return fail("FLAG_NOT_ALLOWED", `${arg.split("=")[0]}=… isn't accepted: pass the flag and its value as two arguments.`)
    // The CLI keeps a repeated flag's last value, while the card's words and checks would read one of them:
    // each flag once, so both read the same.
    if (flags.has(arg) && !repeats(row.path, arg)) return fail("BAD_ARGS", `${arg} is given twice: give each flag once.`)
    if (allowed.value.has(arg)) {
      const value = rest[i + 1]
      if (value === undefined || (value.startsWith("-") && !dashPrefixValue(entry, arg, value))) return fail("BAD_ARGS", `${arg} needs a value.`)
      flags.set(arg, value)
      i++
    } else if (allowed.boolean.has(arg)) {
      flags.set(arg, true)
    } else {
      const declared = [...(entry.flags?.value ?? []), ...(entry.flags?.boolean ?? [])].includes(arg)
      // A path the pane asks the user for (left to it, the agent asked for vault backup's --to in chat, then passed it).
      const asked = row.pane?.askPaths?.find((p) => p.flag === arg)
      if (asked) return fail("FLAG_NOT_ALLOWED", `Leave ${arg} out: the prompt pane asks the user for it when the step runs. Propose the step without it, and don't ask the user for it in chat.`)
      return fail(
        "FLAG_NOT_ALLOWED",
        declared
          ? `${arg} isn't taken from the agent: it changes who or where the command runs, or what it reads or writes on disk. The Candle Harness adds what's needed.`
          : `candle ${base} has no ${arg} flag.`,
      )
    }
  }
  // An action word is read only when it comes first: one later would run as another row than the one checked here.
  const late = action ? undefined : positionals.find((w) => rowFor(`${base} ${w}`))
  if (late !== undefined) return fail("BAD_ARGS", `"${terminalText(late, { maxLength: 40 })}" is one of candle ${base}'s actions: put it first, before the flags and other words.`)
  if (row.takes !== undefined && positionals.length > row.takes) {
    return fail("BAD_ARGS", `candle ${row.path} takes ${row.takes === 0 ? "no word but its flags" : `${row.takes} word${row.takes === 1 ? "" : "s"} besides its flags`}: "${terminalText(positionals[row.takes]!, { maxLength: 40 })}" is one too many.`)
  }
  // image upload's path is the one the agent may give: the card checks it's in the research folder.
  if (positionals.length > 0 && (entry.flags?.pathPositionals ?? []).length > 0 && row.card?.kind !== "upload") {
    return fail("PATH_NOT_ALLOWED", `candle ${base} takes a file path, which the agent can't give. The user runs it in their own terminal.`)
  }
  // A secret goes into the CLI's hidden prompt, in the pane: on a command line it would reach the journal.
  const most = row.pane?.positionals
  if (most !== undefined && positionals.length > most) {
    return fail("SECRET_AT_THE_PROMPT", `candle ${row.path} takes ${most === 0 ? "no word but its flags" : "the secret's name only"}: the secret goes into the CLI's hidden prompt, in a pane the agent can't see, never on a command line. Nothing was run.`)
  }

  const refined = row.byFlags?.(flags)
  const rule = refined?.rule ?? row.rule
  const route = refined?.route ?? row.route
  let agent: string | undefined
  if (row.identity === "agent") {
    agent = typeof input.agent === "string" ? input.agent : ctx.defaultAgent
    if (!ctx.agents.has(agent)) return fail("UNKNOWN_AGENT", `No agent named "${terminalText(agent)}" has a key in the Candle Harness.`)
  }
  const takes = (flag: string) => (entry.flags?.value ?? []).includes(flag) || (entry.flags?.boolean ?? []).includes(flag)
  const argv = [command, ...(subcommand === null ? [] : [subcommand as string]), ...head, ...rest]
  // Narrowing access runs unattended once approved, so it answers its own confirmation.
  if (rule === "less-access" && takes("--yes")) argv.push("--yes")
  return { ok: true, call: { row, rule, route, identity: row.identity, ...(agent ? { agent } : {}), argv, json: entry.json, withRpcUrl: takes("--rpc-url"), takesYes: takes("--yes"), valueFlags: entry.flags?.value ?? [] } }
}

/** `sign`'s card line: the external key it signs with, and whether it also sends what it signed. */
function signsWith(words: readonly string[]): string {
  // `sign` takes --wallet once for each signer of a multi-signer transaction: the card names every one.
  const wallets = words.flatMap((w, i) => (w === "--wallet" && words[i + 1] !== undefined ? [terminalText(words[i + 1]!, { maxLength: 44 })] : []))
  const sends = words.includes("--broadcast") ? ", then sends it to the chain" : ""
  return wallets.length > 0 ? `Signs with ${wallets.join(" and ")}${sends}.` : `Signs with an external key, the one the CLI picks: no --wallet is named${sends}.`
}

/** What the agent is told about a rule it can't use yet. */
function notYet(call: ResolvedCall): string {
  const what: Record<CliRule, string> = {
    read: "a read",
    "less-access": "narrowing access",
    card: "a card",
    owner: "the owner's approval with the vault factor",
    ceremony: "the user, at the CLI's own prompt",
    "funds-out": "moving funds out, approved by the owner",
    mcp: "",
    never: "",
  }
  if (call.row.held) return `candle ${call.argv.join(" ")} isn't in the Candle Harness: ${call.row.held}`
  return `candle ${call.argv.join(" ")} needs ${what[call.rule]}, which isn't in the Candle Harness yet. The user can run it in their own terminal now.`
}

/** A pane card's kind, by its row's rule. */
const PANE_KIND: Partial<Record<CliRule, CardKind>> = { owner: "owner", ceremony: "ceremony", "funds-out": "funds-out", "less-access": "lessaccess", read: "read" }

/**
 * Whether a call runs in the prompt pane now: a read or a narrowing that asks at the CLI's own prompt
 * (`tee disable`, `tee fund`: the core has no terminal), and the owner, ceremony and funds-out rows.
 */
function paneNow(call: ResolvedCall): boolean {
  return runsInPane(call.row, call.rule) && (call.row.pane?.needsPrompt !== undefined || paneRowNow(call.rule, call.route))
}

/** The held card rows, grouped by why: "lp add, lp remove, lp claim (Candle hasn't …)". */
function heldByReason(): string {
  const groups = new Map<string, string[]>()
  for (const row of CLI_ROWS) if (row.card?.held !== undefined) groups.set(row.card.held, [...(groups.get(row.card.held) ?? []), `${row.path}${row.via ? " from a TEE wallet" : ""}`])
  return [...groups].map(([why, paths]) => `${paths.join(", ")} (${why.replace(/\.$/, "")})`).join("; ")
}

/** The amber line on a `tee disable` card: a stop is final, since the CLI never re-enables a TEE wallet. */
/** A promote that makes the vault's first EVM TEE wallet: the CLI moves the vault file to version 4 as it writes it. */
export const VAULT_V4_NOTE = "This is the vault's first Hood TEE wallet, so the CLI moves the vault file to version 4: an older candle CLI can't open it after this. Keep candle at 0.13.20 or later on every machine that uses this vault."

/**
 * A Hood TEE wallet's sweep, said before it runs: what it needs, and the CLI's refusals the pane will show by their codes,
 * since what the pane shows never reaches the Candle Harness.
 */
export const HOOD_SWEEP_NOTE = "A Hood TEE wallet sweeps its tokens, then its ETH last, paying gas in ETH. It needs the wallet stopped first and ETH in it (EVM_SWEEP_NEEDS_GAS), and is refused while a bridge with it is open, up to two hours (BRIDGE_IN_FLIGHT), or a trade holds it (WALLET_BUSY): the pane says which."

export const STOP_IS_FINAL = "Permanent: Candle never re-enables a stopped TEE wallet. Next you sweep it home (candle tee sweep), then make a new one."
/** `vault demote` stops each wallet it names, then sweeps it home: said before the press, as for `tee disable`. */
export const DEMOTE_IS_FINAL = "Permanent: Candle never re-enables a stopped TEE wallet, so it can never trade again. Its funds go home to your vault."

/** The tool's description, generated from the table, so it names every command, its rule and whether it runs now. */
export function describeTool(): string {
  const group = (pred: (row: CliRow) => boolean) => CLI_ROWS.filter(pred).map((row) => row.path)
  /** A command's own subcommands under the same rule go without saying once the command is named. */
  const parents = (paths: string[]) => paths.filter((p) => !paths.some((q) => p.startsWith(`${q} `)))
  /** Rows gathered by what they share, in the table's order: "a, b, c → tool" once, never a line a row. */
  const gathered = (rows: readonly CliRow[], key: (row: CliRow) => string) => {
    const by = new Map<string, string[]>()
    for (const row of rows) by.set(key(row), [...(by.get(key(row)) ?? []), row.path])
    return [...by]
  }
  // Every perps read's tool is named after it, so the rule is said once.
  const perpsRead = (r: CliRow) => r.rule === "mcp" && r.mcpTool === `candle_${r.path.replace(" ", "_")}` && r.path.startsWith("perps ")
  const perpsReads = CLI_ROWS.filter(perpsRead).map((r) => r.path.slice("perps ".length))
  const PANE = "a card, then a terminal pane you can't see"
  const lines = [
    "Runs one command of the user's Candle CLI (candle) through the Candle Harness, with no shell. Use it for what Candle's MCP tools don't cover. Give the command word, the subcommand, and the rest as a list of arguments; --json and the RPC URL are added for you.",
    `Runs at once (read): ${group((r) => r.rule === "read" && r.route === "cli" && !r.pane?.needsPrompt).join(", ")}.`,
    `Becomes a one-press card for the user (it only narrows access): ${group((r) => r.rule === "less-access" && r.route === "cli" && !r.pane?.needsPrompt).join(", ")}. Also keys access --access read, keys update --embedded-wallet deny, keys wallets scope --scope selected.`,
    `Asks for the user's vault passphrase at the CLI's own prompt, so it becomes ${PANE}: ${group((r) => r.pane?.needsPrompt !== undefined).join(", ")}. From any pane you learn only how it ended. Pass the TEE wallet's address, not its label.`,
    `Owner steps, the user's to approve: propose one only when the user asks for it. Each becomes ${PANE}, where the user gives their vault factor and answers the CLI's own prompts: ${group((r) => r.rule === "owner" && paneRowNow(r.rule, r.route)).join(", ")}. Also keys access widening, keys update --embedded-wallet allow, tee status --verify.`,
    `At the CLI's own prompt, the user's alone: propose one only when the user asks for it. Each becomes ${PANE}, where the user types or is shown a secret (a private key, the 24 words, a passphrase, an API key) or names a file; you never learn what it showed: ${group((r) => r.rule === "ceremony" && paneRowNow(r.rule, r.route)).join(", ")}. Also vault status --unlock. Never put a secret in args: secrets set takes the name only, and wallets import no key. Never ask the user for a path a step takes (vault backup's --to, a file to sign or verify): propose it without one, and the pane asks them.`,
    `Moving funds out, the user's alone: propose one only when the user asks for it in their own message this turn, naming where it goes and how much (a sweep: the wallet and everything), and name the destination as they did. Send the asset they named (SOL when they name none; a token by the mint they gave in full) from the wallet they named, if they named one. Each becomes ${PANE}, where the CLI asks for the vault passphrase itself and prints the destination for a typed confirm: ${group((r) => r.rule === "funds-out" && paneRowNow(r.rule, r.route)).join(", ")}, and vault fund. Their arguments: vault transfer <to> --amount <n> --asset SOL|<mint> --from <vault key or TEE wallet label>, with --amount max for all of that asset only when the user asks to send everything; tee sweep <TEE wallet address>; external sweep <external key label> --to <vault key label>; vault fund <TEE wallet address or external key label> --amount <n> --asset SOL|USDC. A destination that looks like one of the user's own but isn't is refused; a new address shows amber on the card, and the user's click on it is the approval. Pass a TEE wallet by its address; a vault key by its label or address.`,
    "keys create makes a new agent in the Candle Harness: name it with --label <agent-name>; it's Write unless you pass --access or --scopes, never one that moves funds, and its embedded wallet starts denied (allowing it is keys update, a second owner step). --tx-limit <usd> sets Candle's own cap on the key, reset daily unless --reset says otherwise: offer one on every new agent, an LP agent too. An existing key can't gain lp:write: for LP, make a new agent with --scopes " +
      `${LP_AGENT_SCOPES.join(",")} and a name such as <agent>-lp; the Candle Harness then offers it a fresh TEE wallet from the vault, promoted to its key and funded, one step at a time. Never rebind or change another agent's key to do it.`,
    `Becomes a one-press card for the user, run with your key: ${group((r) => r.card !== undefined && r.card.held === undefined).map((p) => (p.startsWith("stake ") ? `${p} --wallet <TEE wallet>` : p === "image upload" ? `${p} <a file in your research folder>` : p)).join(", ")}. The Candle Harness adds the id and --yes where the command takes them; never pass --client-trade-id or --client-stake-id.`,
    `Use the MCP tool instead: ${gathered(CLI_ROWS.filter((r) => r.rule === "mcp" && !perpsRead(r)), (r) => r.mcpTool ?? "").map(([tool, paths]) => `${parents(paths).join(", ")} → ${tool}`).join("; ")}${perpsReads.length ? `; perps ${perpsReads.join(", ")} → candle_perps_<that word>` : ""}.`,
    `Done another way: ${CLI_ROWS.filter((r) => r.via !== undefined).map((r) => `${r.path} → ${r.via}`).join(", ")}.`,
    `Coming, held until each is checked live: ${heldByReason()}. A TEE wallet allowed to launch still can't launch through the Candle Harness until then: say so rather than ask for a launch's details.`,
    ...(group((r) => r.route === "pane" && !paneRowNow(r.rule, r.route)).length ? [`Coming: ${group((r) => r.route === "pane" && !paneRowNow(r.rule, r.route)).join(", ")}.`] : []),
    ...gathered(CLI_ROWS.filter((r) => r.held !== undefined), (r) => r.held ?? "").map(([why, paths]) => `Not in the Candle Harness: ${paths.join(", ")}. ${why}`),
    `Later (perps writes): ${parents(group((r) => r.route === "later" && r.rule !== "never" && r.rule !== "mcp" && r.held === undefined)).join(", ")}.`,
    `Never through the agent: ${parents(group((r) => r.rule === "never")).join(", ")}.`,
    "Never pass --profile, --api-url, --yes, --rpc-url, --json, file paths (but image upload's, inside your research folder) or --flag=value: they're refused. Moving funds or changing access the user didn't ask for is never yours to start.",
  ]
  return lines.join("\n")
}

export const CLI_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    command: { type: "string", description: "The command word, such as keys." },
    subcommand: { type: "string", description: "The subcommand, such as revoke. Leave it out for a command with none." },
    args: { type: "array", items: { type: "string" }, description: 'The rest, one item per argument, such as ["abc123"] or ["--limit", "10"].' },
    reason: { type: "string", description: "Why, in a sentence: shown to the user on a card." },
  },
  required: ["command"],
}

export class CliTool {
  constructor(
    private readonly deps: {
      cli: CandleCli
      redactor: Redactor
      journal: Journal
      cards: CardDesk
      agents: () => ReadonlySet<string>
      mode: () => "paper" | "live"
      /** The TEE wallets the key with this prefix holds (AgentWallets.teeOnKey), for the stranding warning. */
      teeOnKey?: (prefix: string) => { id: string; address: string; label?: string }[]
      /** After a less-access command ran: what each agent may pay from may have changed. */
      onAccessChanged?: () => void
      /** Runs and reads back the CLI's card rows. */
      cliCards?: CliCards
      /** Typed card rows are a one-press card by default; "instant" approves a typed one at once. */
      typedCards?: () => "card" | "instant"
      /**
       * The core's own approval of a typed card, in the same call: "instant" under cards.typedTrades,
       * or "typed" for a line that runs in the prompt pane (its answer carries the pane's ticket).
       */
      approveInstant?: (viewClientId: string, card: CardView, how?: "instant" | "typed") => Promise<unknown>
      /** Every agent in config.toml, keyed or not: a new agent's name must be free. */
      configured?: () => ReadonlySet<string>
      maxAgents?: number
      /** Each agent's key prefix: who a rebind moves a wallet from and to. */
      agentPrefixes?: () => ReadonlyMap<string, string>
      /** Whether a label, address or id names a TEE wallet bound to an agent's key. */
      isTee?: (wallet: string) => boolean
      /** Whether a promote from this vault key makes the vault's first EVM TEE wallet. */
      firstEvmTee?: (from: string) => boolean
      /** What a wallet is called, from the core's one book. */
      nameOf?: (address: string, label?: string) => string
      /** Where funds may go: the user's own wallets, vault keys and pinned vaults. */
      destinations?: () => Destination[] | Promise<Destination[]>
      /** The user's own message in the turn a harness acts for; undefined for a harness with no turn. */
      askedText?: (client: FaceClient) => string | undefined
      /** Whether a TEE wallet is still enabled (the portfolio's active flag); undefined when unknown. */
      teeEnabled?: (address: string) => boolean | undefined
      /** A TEE wallet's pinned vault, from the wallets read. */
      pinnedVault?: (address: string) => string | undefined
      /** A TEE wallet stopped for good, or swept and retired. */
      gone?: (address: string) => "stopped" | "retired" | undefined
      /** That this machine has had a vault: with it and no vault, owner rows are refused. */
      vaultMark?: { seen(): boolean; note(): Promise<boolean> }
      /** The plan renewal the CLI would make in front of these words at a terminal (its auto-renew, from 0.13.9). */
      renewBefore?: (words: readonly string[]) => RenewDue | undefined
    },
  ) {}

  definition() {
    return { name: "candle_cli", description: describeTool(), inputSchema: CLI_TOOL_SCHEMA }
  }

  /** The agent's call. */
  async call(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<ToolResult> {
    // A refusal names the command and says why, in the journal too ("NOT_YET" alone left the agent filing
    // close-empty's refusals under another step).
    const command = [args.command, args.subcommand].filter((w): w is string => typeof w === "string" && w !== "").join(" ")
    // A harness acts only as its own agent: another agent's key, folder and budget are never its to use.
    if (client.role === "harness" && args.agent !== undefined && args.agent !== client.agent) {
      return this.refuse(client, "NOT_YOUR_AGENT", `candle_cli runs with your own key only, as ${client.agent}. Leave agent out. Nothing was run.`, command)
    }
    const resolved = resolveCall({ command: args.command, subcommand: args.subcommand, args: args.args, agent: client.role === "harness" ? client.agent : args.agent }, { defaultAgent: client.agent, agents: this.deps.agents() })
    if (!resolved.ok) return this.refuse(client, resolved.code, resolved.message, command)
    const call = resolved.call
    // A swap is the card path's; only --dry-run, a read, runs here.
    if (call.row.path === "swap" && call.rule !== "read") return this.refuse(client, "USE_MCP_TOOL", SWAP_FOR_AGENT, command)
    // A card row whose flags make it a read (`launch --check`, `swap --dry-run`) runs as one.
    if ((call.row.card || call.row.via !== undefined) && call.rule === "read" && call.route === "cli" && !paneNow(call)) return this.output(await this.run(call), this.final(call))
    if (call.row.card) {
      const stop = this.cardRowStop(call)
      if (stop) return this.refuse(client, stop.code, stop.message, command)
      try {
        return cardAnswer(await this.proposeRow(client, call, reason))
      } catch (error) {
        const e = error as { code?: unknown; message?: unknown; details?: unknown }
        if (typeof e.code !== "string") throw error
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: { code: e.code, message: String(e.message) }, ...((e.details as Record<string, unknown>) ?? {}) }) }], isError: true }
      }
    }
    if (call.row.via !== undefined) return this.refuse(client, "USE_MCP_TOOL", call.row.note ?? `Use ${call.row.via}.`, command)
    if (call.rule === "mcp") return this.refuse(client, "USE_MCP_TOOL", call.row.note ?? `Use ${call.row.mcpTool} for this: it's Candle's own tool, and faster.`, command)
    if (call.rule === "never") return this.refuse(client, "NOT_FOR_AGENT", call.row.note ?? "This isn't something the agent runs.", command)
    // A step the user answers at the CLI's own prompt: a card, then the pane the agent can't see.
    if (paneNow(call)) {
      try {
        return cardAnswer(await this.proposePane(client, call, reason))
      } catch (error) {
        const e = error as { code?: unknown; message?: unknown }
        if (typeof e.code !== "string") throw error
        return this.refuse(client, e.code, String(e.message), command)
      }
    }
    if (call.route !== "cli" || (call.rule !== "read" && call.rule !== "less-access")) return this.refuse(client, "NOT_YET", notYet(call), command)

    if (call.rule === "read") return this.output(await this.run(call), this.final(call))

    // Narrowing access, proposed by the agent: a one-press card bound to exactly what will run, every
    // flag the core adds included.
    const params = { argv: this.final(call), identity: call.identity, ...(call.agent ? { agent: call.agent } : {}), json: call.json }
    const card = await this.deps.cards.propose({
      client,
      agent: call.agent ?? client.agent,
      tool: "candle_cli",
      args: { cli: params },
      params,
      kind: "lessaccess",
      idKey: "coreOpId",
      title: `LESS ACCESS · candle ${call.argv.filter((a) => a !== "--yes").join(" ")}`,
      // (The title leaves out what the core adds; the hash covers it.)
      ...(reason !== undefined ? { reason } : {}),
      ...(this.strands(call) ? { warning: this.strands(call)!, fills: this.strandFills(call) } : {}),
    })
    return cardAnswer(card)
  }

  /**
   * The user's own typed line (`cli.run` from a view): reads and narrowing run at once, as the user's. A
   * refusal is journaled with its command and words, never the line (a mistyped secret could be in it), so
   * the agent's record has it (without it, a typed look-alike was missing from the agent's account).
   */
  async runTyped(viewClientId: string, words: unknown, agent: string): Promise<Record<string, unknown>> {
    try {
      return await this.typed(viewClientId, words, agent)
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown }
      if (typeof e.code === "string") {
        const w = Array.isArray(words) ? words.filter((x): x is string => typeof x === "string") : []
        const command = w[0] === undefined ? undefined : w[1] !== undefined && sourceFor(w[0], w[1]) !== undefined ? `${w[0]} ${w[1]}` : w[0]
        await this.deps.journal.append({
          type: "cli.refused",
          mode: this.deps.mode(),
          agent,
          by: viewClientId,
          role: "view",
          code: e.code,
          message: this.deps.redactor.text(String(e.message)).slice(0, MAX_REFUSAL),
          ...(command && /^[a-z][a-z-]{0,30}( [a-z][a-z-]{0,30})?$/.test(command) ? { command } : {}),
        })
      }
      throw error
    }
  }

  private async typed(viewClientId: string, words: unknown, agent: string): Promise<Record<string, unknown>> {
    if (!Array.isArray(words) || words.length === 0 || !words.every((w) => typeof w === "string")) throw refused("BAD_ARGS", "argv must be the words after candle.")
    const [command, maybeSub, ...rest] = words as string[]
    const hasSub = maybeSub !== undefined && sourceFor(canonicalCommand(command!), maybeSub) !== undefined
    const resolved = resolveCall({ command, subcommand: hasSub ? maybeSub : undefined, args: hasSub ? rest : [maybeSub, ...rest].filter((w) => w !== undefined) }, { defaultAgent: agent, agents: this.deps.agents() })
    if (!resolved.ok) throw refused(resolved.code, resolved.message)
    const call = resolved.call
    if (call.row.path === "swap" && call.rule !== "read") throw refused("USE_THE_HARNESS", SWAP_TYPED)
    // The CLI's card rows: the same card the agent's request makes, or at once
    // under cards.typedTrades = "instant", approved by the core in this call. One whose flags make it
    // a read (`launch --check`) runs below, as reads do.
    if (call.row.card && call.rule === "card") {
      const stop = this.cardRowStop(call)
      if (stop) throw refused(stop.code === "USE_MCP_TOOL" ? "ASK_THE_AGENT" : stop.code, stop.code === "USE_MCP_TOOL" ? `Ask the agent: from the embedded wallet it's Candle's own tool (${call.row.via}), a one-press card. Nothing was run.` : stop.message)
      await this.deps.journal.append({ type: "cli.typed", mode: this.deps.mode(), ...(call.agent ? { agent: call.agent } : {}), by: viewClientId, argv: call.argv, rule: call.rule })
      const card = await this.proposeRow({ clientId: viewClientId, role: "view", agent: call.agent! }, call)
      // Closing empty accounts typed (or from the Wallets pane's chip) runs at once, as narrowing access does:
      // nothing leaves the wallet. Inside it's still the card, approved as "typed".
      if (call.row.card.kind === "close" && this.deps.approveInstant) {
        const instant = await this.deps.approveInstant(viewClientId, card, "typed")
        return { ...card, instant, said: `${(card as { display?: { title?: string } }).display?.title ?? "CLOSE EMPTY ACCOUNTS"}: approved as typed. Activity says how it ends; the rent comes back to the same wallet.` }
      }
      if (this.deps.typedCards?.() === "instant" && this.deps.approveInstant) return { ...card, instant: await this.deps.approveInstant(viewClientId, card) }
      return card as unknown as Record<string, unknown>
    }
    // A tool of the Candle Harness's own (hacc_lab) is the agent's; Candle's tools feed what the Candle Harness shows.
    if (call.rule === "mcp" && call.route === "cli" && !call.row.mcpTool?.startsWith("candle_")) throw refused("ASK_THE_AGENT", `Ask the agent: it runs this with ${call.row.mcpTool}. Nothing was run.`)
    if (call.rule === "mcp" && call.route === "cli") throw refused("USE_THE_HARNESS", `The Candle Harness shows this itself (${call.row.mcpTool}).`)
    // Candle's MCP cards: the agent proposes them; typed, they come with the typed card rows.
    if (call.row.via !== undefined && call.rule === "card") throw refused("ASK_THE_AGENT", `Ask the agent: it proposes this as a one-press card (${call.row.via}). Nothing was run.`)
    if (call.rule === "never") throw refused("NOT_IN_THE_HARNESS", call.row.note ?? "Run it in your own terminal.")
    // Typed, a step that asks at the CLI's own prompt opens the pane at once: the user typed it, and
    // every prompt is in the pane. Inside it's still a card, approved as "typed", so every pane goes
    // through the one ticket path. The answer carries the ticket, for this view only.
    if (paneNow(call)) {
      if (!this.deps.approveInstant) throw refused("METHOD_NOT_AVAILABLE", "The prompt pane isn't in this build of the core.")
      await this.deps.journal.append({ type: "cli.typed", mode: this.deps.mode(), ...(call.agent ? { agent: call.agent } : {}), by: viewClientId, argv: call.argv, rule: call.rule })
      const card = await this.proposePane({ clientId: viewClientId, role: "view", agent: call.agent ?? agent }, call, undefined, true)
      // A new address is the amber card, approved by a click, even typed.
      if ((card as { display?: { newAddress?: string } }).display?.newAddress) return { kind: "card", cardId: card.cardId, newAddress: true }
      // A stop is for good, so it's a card even typed (the kill report's chip types it), read before the press.
      if (call.row.path === "tee disable") return { kind: "card", cardId: card.cardId, said: `candle ${call.argv.join(" ")}: a stop is for good, so it's a card. Read it, then approve it.` }
      return (await this.deps.approveInstant(viewClientId, card, "typed")) as Record<string, unknown>
    }
    if (call.route !== "cli" || (call.rule !== "read" && call.rule !== "less-access")) throw refused("NOT_YET", notYet(call))
    await this.deps.journal.append({ type: "cli.typed", mode: this.deps.mode(), ...(call.agent ? { agent: call.agent } : {}), by: viewClientId, argv: call.argv, rule: call.rule })
    // Read before it runs: once the key is revoked, the wallets it held are no agent's.
    const warning = call.rule === "less-access" ? this.strands(call) : undefined
    const result = await this.run(call)
    // What came of a typed run is journalled too, not only its request, so whether a revoke worked needn't come from keys list.
    await this.deps.journal.append({ type: "cli.typed_result", mode: this.deps.mode(), ...(call.agent ? { agent: call.agent } : {}), argv: call.argv, exitCode: result.exitCode, timedOut: result.timedOut === true })
    if (call.rule === "less-access") this.deps.onAccessChanged?.()
    const answer = JSON.parse(this.output(result, this.final(call)).content[0]!.text) as Record<string, unknown>
    return warning ? { ...answer, warning } : answer
  }

  /**
   * Runs an approved candle_cli card: one of the CLI's card rows (cli-cards.ts), or narrowing access,
   * where exit 3 means the CLI isn't sure it's done yet (such as a stop still pending).
   */
  async execute(op: Operation): Promise<Mapped> {
    if (typeof op.params.row === "string") {
      if (!this.deps.cliCards) return { state: "refused", error: { code: "METHOD_NOT_AVAILABLE", message: "The CLI's card rows aren't in this build of the core.", retryable: false } }
      return this.deps.cliCards.execute(op)
    }
    const p = op.params as { argv: string[]; identity: Identity; agent?: string; json: boolean }
    const result = await this.deps.cli.runExact({ ...(p.identity === "agent" ? { agent: p.agent! } : {}), argv: p.argv, json: p.json })
    const output = this.redacted(result)
    this.deps.onAccessChanged?.()
    if (result.timedOut) return { state: "unknown", result: output, reason: "the CLI didn't finish in time" }
    if (result.exitCode === 0) return { state: "succeeded", result: output }
    if (result.exitCode === 3) return { state: "unknown", result: output, reason: "the CLI says it isn't confirmed yet (exit 3)" }
    return { state: "refused", result: output, error: { code: `CLI_EXIT_${result.exitCode}`, message: String(output.stderr || output.output).slice(0, 500), retryable: false } }
  }

  /** One read back of a CLI card row by its rule, or undefined when there's none to make now. Less access has none. */
  readBack(op: Operation): Promise<{ mapped: Mapped; detail: string } | undefined> {
    if (typeof op.params.row !== "string" || !this.deps.cliCards) return Promise.resolve(undefined)
    return this.deps.cliCards.read(op)
  }

  /**
   * Why a card row can't become a card now, before anything is read: the embedded wallet's form is
   * Candle's own tool; a held row is coming, with why; paper mode has no form of it.
   */
  private cardRowStop(call: ResolvedCall): { code: string; message: string } | undefined {
    const spec = call.row.card!
    const at = call.argv.indexOf("--wallet")
    const word = at >= 0 ? call.argv[at + 1] : undefined
    if (call.row.via !== undefined && (word === undefined || word === "main" || word === "embedded")) return { code: "USE_MCP_TOOL", message: call.row.note ?? `Use ${call.row.via}.` }
    // The embedded wallet's form of close-empty is never the agent key's, held or not; its address is caught when the card is planned.
    if (spec.embeddedHeld !== undefined && (word === undefined || word === "main" || word === "embedded")) return { code: "NEEDS_TRANSFER_WRITE", message: `candle ${call.row.path} from the embedded wallet isn't in the Candle Harness: ${spec.embeddedHeld} Nothing was run.` }
    if (spec.held !== undefined) return { code: "NOT_YET", message: `candle ${call.row.path}${call.row.via ? " from a TEE wallet" : ""} is coming: ${spec.held} Nothing was run.` }
    if (this.deps.mode() === "paper") return { code: "NO_PAPER_FORM", message: "This is paper mode, and this has no paper form: switch to live to do it. Nothing was run." }
    return undefined
  }

  /** A row that runs in the prompt pane, as a card: the card book plans its steps (pane-plan.ts) and binds them. */
  /**
   * A rename the core planned: `tee rename` or `vault rename`, of one wallet, or of a batch
   * from a `--pairs-from` file the core wrote into its state folder (the agent never names a path). The argv is
   * the core's own, so it isn't checked against the agent's allowlist; it still goes the one pane-card way.
   * Typed (the person's `name` line or chip): the pane at once. From the agent: a card. A batch shows the CLI's
   * `--dry-run` first, and runs only once the person types yes.
   */
  async rename(client: FaceClient, input: { path: "tee rename" | "vault rename"; args: string[]; renames: { address: string; name: string }[]; preview: boolean; factorFirst?: boolean; typed: boolean; reason?: string }): Promise<{ kind: "card"; card: CardView } | { kind: "opened"; opened: unknown }> {
    const [command, subcommand] = input.path.split(" ") as [string, string]
    const row = rowFor(input.path)!
    const call: ResolvedCall = {
      row,
      rule: row.rule,
      route: row.route,
      identity: row.identity,
      argv: [command, subcommand, ...input.args],
      json: false,
      withRpcUrl: false,
      takesYes: false,
      valueFlags: sourceFor(command, subcommand)?.flags?.value ?? [],
    }
    // As one rename: the CLI unlocks the vault itself for a TEE wallet the Candle Harness knows, so the factor isn't asked twice.
    let factorFirst = input.factorFirst
    if (factorFirst === undefined && input.path === "tee rename" && input.renames.some((r) => this.deps.isTee?.(r.address)) && (await this.vaultState()) === "present") factorFirst = false
    const extra: Partial<PaneRequest> = { renames: input.renames, ...(input.preview ? { preview: true as const } : {}), ...(factorFirst !== undefined ? { factorFirst } : {}) }
    const card = await this.proposePane(client, call, input.reason, input.typed, extra)
    if (!input.typed) return { kind: "card", card }
    if (!this.deps.approveInstant) throw refused("METHOD_NOT_AVAILABLE", "The prompt pane isn't in this build of the core.")
    return { kind: "opened", opened: await this.deps.approveInstant(client.clientId, card, "typed") }
  }

  /**
   * Onboarding's Candle sign-in: `auth login` with the profile and host the core chose, never words from the
   * agent (`--profile` and `--api-url` are refused from it). The person's own step, from the main view, so the
   * pane opens at once; it goes the one pane-card way, with its hash.
   */
  async signIn(client: FaceClient, input: { profile: string; apiUrl?: string }): Promise<unknown> {
    const row = rowFor("auth login")!
    const call: ResolvedCall = {
      row,
      rule: row.rule,
      route: row.route,
      identity: row.identity,
      argv: ["auth", "login", "--profile", input.profile, ...(input.apiUrl ? ["--api-url", input.apiUrl] : [])],
      json: false,
      withRpcUrl: false,
      takesYes: false,
      valueFlags: sourceFor("auth", "login")?.flags?.value ?? [],
    }
    const card = await this.proposePane(client, call, undefined, true)
    if (!this.deps.approveInstant) throw refused("METHOD_NOT_AVAILABLE", "The prompt pane isn't in this build of the core.")
    return this.deps.approveInstant(client.clientId, card, "typed")
  }

  private async proposePane(client: FaceClient, call: ResolvedCall, reason?: string, typed = false, extra: Partial<PaneRequest> = {}): Promise<CardView> {
    const prepared = await this.preparePane(call, { client, typed })
    if (!prepared.ok) throw refused(prepared.code, prepared.message)
    const request: PaneRequest = { ...prepared.request, ...extra }
    // Typed, there's no card to show the way out on: say it, and run nothing.
    if (typed && request.blocked) throw refused("NO_VAULT", `${request.blocked.why} Set one up first: ${request.blocked.fill.line}. Nothing was run.`)
    return this.deps.cards.propose({
      client,
      agent: call.agent ?? client.agent,
      tool: "candle_cli",
      args: { cli: call.argv },
      params: { cli: request.words },
      kind: PANE_KIND[call.rule] ?? "unknown",
      idKey: "coreOpId",
      pane: request,
      // The agent names the new agent; the user changes it by editing the line and typing it. Only words the
      // input line reads back as they are: a space or ";" in one would split it into other words, or a second command.
      ...(request.newAgent && request.words.every((w) => PLAIN_WORD.test(w)) ? { fills: [{ label: "change the name", line: `candle ${request.words.join(" ")}` }] } : {}),
      ...(request.fills?.length ? { fills: request.fills } : {}),
      ...(request.warning ? { warning: request.warning } : {}),
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  /**
   * What a pane card needs before it's made, read now and never on approve: whether there's a
   * vault for the factor step, and the card's words (who a new key makes, what a rebind moves, what a
   * preset drops). Reads run as the owner, with no unlock.
   */
  private async preparePane(call: ResolvedCall, ctx: { client: FaceClient; typed: boolean }): Promise<{ ok: true; request: PaneRequest } | { ok: false; code: string; message: string }> {
    // A card's words describe the CLI the table was read from; an older one may do something else. Its update
    // runs, and so does the sign-in setup opens on, so a first run on an older CLI can still reach Candle.
    const old = call.row.path === "update" || call.row.path === "auth login" ? undefined : await this.olderCli()
    if (old) return { ok: false, code: "CLI_TOO_OLD", message: `candle ${old} is older than the Candle Harness needs (${MIN_CANDLE_CLI}): run candle update, then ask again. Nothing was run.` }
    let words = call.argv
    const notes: string[] = []
    let newAgent: string | undefined
    let factorFirst: boolean | undefined
    let funds: Extract<ReturnType<typeof prepareFundsOut>, { ok: true }> | undefined
    const path = call.row.path
    const owner = call.rule === "owner"
    // Funds out, and the owner rows that move funds: the destination checked, and from the
    // agent, asked for this turn in the user's own words. Typed, the line is the ask.
    if (call.rule === "funds-out" || path === "vault fund" || path === "vault demote") {
      const asked = ctx.typed ? undefined : this.deps.askedText?.(ctx.client)
      // No message from the user this turn (a harness with no turn of the core's engine): nothing to read.
      if (!ctx.typed && asked === undefined) return notAsked("message")
      const made = prepareFundsOut(words, {
        known: (await this.deps.destinations?.()) ?? [],
        asked,
        typed: ctx.typed,
        valueFlags: call.valueFlags,
        ...(this.deps.teeEnabled ? { teeEnabled: this.deps.teeEnabled } : {}),
        ...(this.deps.pinnedVault ? { pinnedVault: this.deps.pinnedVault } : {}),
        ...(this.deps.gone ? { gone: this.deps.gone } : {}),
      })
      if (!made.ok) return made
      funds = made
      words = made.words
      notes.push(...made.notes)
    }
    if (path === "keys create") {
      const made = prepareKeysCreate(words, { configured: this.deps.configured?.() ?? this.deps.agents(), maxAgents: this.deps.maxAgents ?? 5 })
      if (!made.ok) return made
      words = made.words
      newAgent = made.newAgent
      notes.push(...made.notes)
      // The CLI keeps a new key as the profile's own when the profile holds none (commands/keys.ts:365-380).
      const status = await this.ownerRead(["auth", "status"])
      if (status && typeof (status as { keyPrefix?: unknown }).keyPrefix !== "string") notes.push("Your CLI profile holds no key of its own, so the CLI also keeps this one as the profile's working key.")
    } else if (path === "keys access") {
      const [target] = positionals(words, call.valueFlags)
      const at = words.indexOf("--access")
      // A key that can move funds never lives in the Candle Harness, so an agent's key is never made one, however
      // the key is named: by prefix, by label (the Candle Harness labels each key with its agent's name), or `self`.
      const prefixes = [...(this.deps.agentPrefixes?.() ?? new Map<string, string>())]
      const toFunds = ["withdraw", "transfer", "read-write-transfer"].includes(words[at + 1] ?? "")
      const noWithdraw = (agent: string) => ({ ok: false as const, code: "NO_WITHDRAW_KEY", message: `${agent}'s key is in the Candle Harness, and a key that can move funds out never lives there. Nothing was run.` })
      const byPrefix = prefixes.find(([, prefix]) => prefix === target)?.[0]
      if (toFunds && byPrefix) return noWithdraw(byPrefix)
      const rows = await this.ownerRead(["keys", "list"])
      const key = ((rows as { keys?: unknown } | undefined)?.keys as { keyPrefix?: unknown; label?: unknown; scopes?: unknown }[] | undefined)?.find((k) => k.keyPrefix === target || k.label === target)
      if (toFunds) {
        const self = target === "self" ? (await this.ownerRead(["auth", "status"]) as { keyPrefix?: unknown } | undefined)?.keyPrefix : undefined
        const named = prefixes.find(([agent, prefix]) => prefix === key?.keyPrefix || prefix === self || agent === target)?.[0]
        if (named) return noWithdraw(named)
      }
      const drops = Array.isArray(key?.scopes) ? presetDrops(key.scopes as string[], at >= 0 ? words[at + 1] : undefined) : undefined
      if (drops) notes.push(drops)
    } else if (path === "tee rebind") {
      const prefixes = this.deps.agentPrefixes?.() ?? new Map<string, string>()
      const to = words[words.indexOf("--to-key") + 1]
      const toAgent = [...prefixes].find(([, prefix]) => prefix === to)?.[0]
      const moving = positionals(words, call.valueFlags).map((wallet) => {
        for (const [agent, prefix] of prefixes) {
          const held = this.deps.teeOnKey?.(prefix).find((w) => w.address === wallet || w.label === wallet || w.id === wallet)
          if (held) return { name: this.walletCalled(held.address, held.label), from: agent }
        }
        return { name: terminalText(short(wallet), { maxLength: 64 }) }
      })
      notes.push(rebindNote(moving, toAgent ? `${toAgent} (${to})` : to))
    } else if (path === "profile use") {
      notes.push("It changes which profile every later candle command runs as, the Candle Harness's owner steps included.")
    } else if (path === "auth logout") {
      notes.push("It revokes this profile's key on Candle and removes the profile: the Candle Harness's owner steps have no identity until you sign in again.")
    }
    // Whether there's a vault, read once for this card, and only where it decides something.
    let vaultNow: Awaited<ReturnType<CliTool["vaultState"]>> | undefined
    const vault = async () => (vaultNow ??= await this.vaultState())
    if (path === "tee sweep" && positionals(words, call.valueFlags).some((w) => isEvmAddress(w))) notes.push(HOOD_SWEEP_NOTE)
    if (path === "vault promote") {
      const from = words[words.indexOf("--from") + 1]
      if (words.includes("--from") && from !== undefined && this.deps.firstEvmTee?.(from)) notes.push(VAULT_V4_NOTE)
    }
    if (path === "tee rename") {
      // The CLI unlocks the vault itself to rename a TEE wallet's entry: no factor step for one the Candle Harness knows.
      const [target] = positionals(words, call.valueFlags)
      const tee = target !== undefined && (this.deps.isTee?.(target) ?? false)
      if (tee && (await vault()) === "present") factorFirst = false
    }
    // A ceremony's line: what it shows or takes. `sign` names the external key it signs with.
    let shows = call.row.pane!.shows
    if (path === "sign" || path === "sign message") shows = signsWith(words)
    // No vault (a vault is optional). A row that needs one whatever the factor keeps its card, `vault init` in place
    // of approve. Any other owner row runs with no factor step, approved by the person in the pane, unless
    // this machine has had a vault: then it's refused, never quietly run without the factor.
    let blocked: PaneRequest["blocked"]
    let noVault: true | undefined
    const paneRule = owner || call.rule === "ceremony" || call.rule === "funds-out"
    const factor = factorFirst ?? call.row.pane!.factorFirst
    if ((factor || (paneRule && needsVault(call.row))) && (await vault()) === "missing") {
      if (needsVault(call.row)) blocked = { why: "No vault on this machine, and this needs one.", fill: { label: "set up a vault", line: "candle vault init" } }
      else if (this.deps.vaultMark?.seen()) return { ok: false, code: "VAULT_GONE", message: VAULT_GONE }
      else noVault = true
    }
    if ((owner || call.rule === "funds-out") && this.deps.mode() === "paper") notes.push(REAL_IN_PAPER)
    // A command that isn't captured runs at the pane's terminal with no --json, where the CLI's auto-renew may pay first.
    const due = call.row.pane!.capture === undefined ? this.deps.renewBefore?.(words.filter((w) => w !== "--json")) : undefined
    const warning = [due ? renewWarning(due) : undefined, funds?.warning ?? (call.row.path === "tee disable" ? STOP_IS_FINAL : call.row.path === "vault demote" ? DEMOTE_IS_FINAL : undefined)].filter((w) => w !== undefined).join(" ")
    return {
      ok: true,
      request: {
        row: call.row,
        rule: call.rule,
        identity: call.identity,
        ...(call.agent ? { agent: call.agent } : {}),
        words,
        rpcUrl: call.withRpcUrl,
        ...(factorFirst !== undefined ? { factorFirst } : {}),
        ...(newAgent ? { newAgent } : {}),
        ...(notes.length ? { notes } : {}),
        ...(blocked ? { blocked } : {}),
        ...(noVault ? { noVault } : {}),
        ...(shows ? { shows } : {}),
        ...(funds?.newAddress ? { newAddress: funds.newAddress } : {}),
        ...(warning ? { warning } : {}),
        ...(due ? { renews: renewWarning(due) } : {}),
        ...(funds?.fills ? { fills: funds.fills } : {}),
      },
    }
  }

  /** What a wallet is called: the core's name for it, else its label or short address. */
  private walletCalled(address: string, label?: string): string {
    return this.deps.nameOf?.(address, label) ?? walletName(undefined, { address, kind: "tee", ...(label ? { label } : {}) })
  }

  /**
   * Whether this machine has a vault, read with no unlock (`vault status --json`; exit 1 and
   * `VAULT_MISSING` with none, which creates nothing, as the real CLI answered). Unreadable never blocks. A
   * vault read is marked, so it can't vanish later to skip the factor.
   */
  async vaultState(): Promise<"present" | "missing" | "unreadable"> {
    const run = await this.deps.cli.runExact({ argv: this.deps.cli.finalArgs({ args: ["vault", "status"], json: true, withRpcUrl: false }), json: true }).catch(() => undefined)
    const body = run?.json as { ok?: unknown; code?: unknown } | undefined
    if (run?.exitCode === 0 && body?.ok === true) {
      if (await this.deps.vaultMark?.note().catch(() => false)) await this.deps.journal.append({ type: "vault.seen", mode: this.deps.mode() }).catch(() => {})
      return "present"
    }
    return body?.code === "VAULT_MISSING" ? "missing" : "unreadable"
  }

  /** A version at or past the minimum, once read: an update never goes back. */
  private cliCurrent = false

  /**
   * The CLI's version when it's older than the Candle Harness needs, read with no key; undefined when it's new enough
   * or didn't answer (unreadable never blocks). Read again until it's new enough, so `candle update` counts at once.
   */
  private async olderCli(): Promise<string | undefined> {
    if (this.cliCurrent) return undefined
    const run = await this.deps.cli.runExact({ argv: ["--version"], json: false, timeoutMs: 15_000 }).catch(() => undefined)
    const version = run?.exitCode === 0 ? /(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1] : undefined
    if (version === undefined) return undefined
    if (versionAtLeast(version, MIN_CANDLE_CLI)) {
      this.cliCurrent = true
      return undefined
    }
    return version
  }

  /** One owner read's JSON, or undefined when it didn't answer. */
  private async ownerRead(args: string[]): Promise<unknown> {
    const run = await this.deps.cli.runExact({ argv: this.deps.cli.finalArgs({ args, json: true, withRpcUrl: false }), json: true }).catch(() => undefined)
    return run?.exitCode === 0 ? run.json : undefined
  }

  /** A card row as a card: the card book plans it (cli-cards.ts) and binds the final argv. */
  private proposeRow(client: FaceClient, call: ResolvedCall, reason?: string): Promise<CardView> {
    const spec = call.row.card!
    const request: CliCardRequest = { row: call.row.path, words: call.argv, valueFlags: call.valueFlags, rpcUrl: call.withRpcUrl, yes: call.takesYes }
    return this.deps.cards.propose({
      client,
      agent: call.agent ?? client.agent,
      tool: "candle_cli",
      args: { cli: call.argv },
      params: { cli: call.argv },
      kind: spec.kind,
      idKey: "coreOpId",
      cli: request,
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  /**
   * The line a less-access step gets when it would leave a TEE wallet with no key that can trade it
   * (revoking a key strands its TEE wallet, and Candle gives no warning). It's still one
   * press: the line informs, it doesn't gate (trader speed over gates).
   *   keys revoke <prefix>                          every TEE wallet the key holds
   *   keys wallets set <prefix> --wallets <id,...>  the ones the new set leaves out
   */
  private strands(call: ResolvedCall): string | undefined {
    const held = this.stranded(call)
    if (held.length === 0) return undefined
    const sub = call.argv[1]
    const names = held.map((w) => this.walletCalled(w.address, w.label))
    const what = held.length === 1 ? `TEE wallet ${names[0]}` : `TEE wallets ${names.join(", ")}`
    const it = held.length === 1 ? "it" : "them"
    const effect = sub === "revoke" ? `Revoking leaves ${it} stranded` : `Leaving ${it} out of the set strands ${it}`
    return `This key holds ${what}. ${effect} until the owner rebinds ${it} (candle tee rebind).`
  }

  /** The rebind chips under the warning: onto each other agent's key, typed by the user. */
  private strandFills(call: ResolvedCall): { label: string; line: string }[] {
    const held = this.stranded(call)
    const from = call.argv[1] === "revoke" ? call.argv[2] : call.argv[3]
    const others = new Map([...(this.deps.agentPrefixes?.() ?? new Map<string, string>())].filter(([, prefix]) => prefix !== from))
    return rebindFills(held, others)
  }

  /** The TEE wallets a less-access step would leave with no key that can trade them. */
  private stranded(call: ResolvedCall): { id: string; address: string; label?: string }[] {
    const [command, sub, ...rest] = call.argv
    if (command !== "keys" || !this.deps.teeOnKey) return []
    const words = positionals(call.argv, call.valueFlags)
    let held: { id: string; address: string; label?: string }[] = []
    if (sub === "revoke" && words[0]) held = this.deps.teeOnKey(words[0])
    else if (sub === "wallets" && words[0] === "set" && words[1]) {
      const at = rest.indexOf("--wallets")
      const kept = new Set((at >= 0 ? (rest[at + 1] ?? "") : "").split(",").map((w) => w.trim()).filter(Boolean))
      held = this.deps.teeOnKey(words[1]).filter((w) => !kept.has(w.id) && !kept.has(w.address))
    }
    return held
  }

  private final(call: ResolvedCall): string[] {
    return this.deps.cli.finalArgs({ args: call.argv, json: call.json, withRpcUrl: call.withRpcUrl })
  }

  private async run(call: ResolvedCall): Promise<CliResult> {
    return this.deps.cli.runExact({ ...(call.identity === "agent" ? { agent: call.agent! } : {}), argv: this.final(call), json: call.json })
  }

  private redacted(result: CliResult): { exitCode: number; output: unknown; stderr: string; truncated: boolean } {
    const raw = result.json !== undefined ? JSON.stringify(this.deps.redactor.value(result.json)) : this.deps.redactor.text(result.stdout)
    const truncated = raw.length > MAX_OUTPUT
    const text = truncated ? raw.slice(0, MAX_OUTPUT) : raw
    let output: unknown = text
    if (result.json !== undefined && !truncated) output = JSON.parse(text)
    return { exitCode: result.exitCode, output, stderr: this.deps.redactor.text(result.stderr).slice(0, MAX_STDERR), truncated }
  }

  /**
   * A read's answer: data from `candle`, which the address gate treats as Candle's own. The RPC from
   * config is left out: it often holds a paid key in its path, which the redactor can't tell from an address.
   */
  private output(result: CliResult, argv: string[]): ToolResult {
    const r = this.redacted(result)
    const body = { source: "candle", command: this.deps.redactor.text(`candle ${rpcToEnv(argv).argv.join(" ")}`), ...r, ...(result.timedOut ? { timedOut: true } : {}) }
    const rpc = this.deps.cli.rpcUrl
    const text = rpc ? JSON.stringify(body).split(JSON.stringify(rpc).slice(1, -1)).join("[the configured RPC]") : JSON.stringify(body)
    return { content: [{ type: "text", text }], ...(result.exitCode !== 0 || result.timedOut ? { isError: true } : {}) }
  }

  private async refuse(client: FaceClient, code: string, message: string, command?: string): Promise<ToolResult> {
    await this.deps.journal.append({
      type: "tool.refused",
      mode: this.deps.mode(),
      agent: client.agent,
      clientId: client.clientId,
      role: client.role,
      tool: "candle_cli",
      code,
      message: this.deps.redactor.text(message).slice(0, MAX_REFUSAL),
      ...(command ? { command: terminalText(this.deps.redactor.text(command), { maxLength: 60 }) } : {}),
    })
    return { content: [{ type: "text", text: JSON.stringify({ success: false, error: { code, message } }) }], isError: true }
  }
}

/** For tests and the commands pane: the canonical form of a resolved call, which a card's hash covers. */
export function callKey(call: ResolvedCall): string {
  return canonicalJson({ argv: call.argv, identity: call.identity, agent: call.agent ?? "" })
}

export type { SourceEntry }
