// What a card that runs in the prompt pane runs, and how its outcome is
// told. Pure: the card book plans it, the hash covers it, the ticket carries it to the launcher, and
// the launcher runs exactly these steps.
//
// The steps:
//   - the factor first (`vault status --unlock --json`, stdout piped so its `ok` or `code` can be read)
//     for a row whose own handler never unlocks (cli-table.ts `factorFirst`);
//   - the command: the row's words, then `--yes` where the core adds it (`profile remove`), `--json`
//     only for the three piped rows, and the configured `--rpc-url` where the command takes it.
// Paths the agent may not give (`askPaths`) are typed by the user in the pane, so they're named here
// but never valued: the core never learns them.
import { terminalText } from "../shared/terminal-text"
import type { CliRow, CliRule, Identity, PaneSpec } from "./cli-table"
import type { Mapped } from "./execute"
import type { Fill } from "./owner-rows"
import { NO_VAULT_STEP } from "./vault-mark"
import { short } from "./wallet-names"

export interface PaneStep {
  /** `preview`: a batch rename's `--dry-run`, shown before the person types yes to run the command. */
  stage: "factor" | "preview" | "command"
  argv: string[]
}

/** A pane card's params: exactly what the launcher runs, and on whose behalf. The hash covers all of it. */
export interface PaneParams {
  pane: {
    row: string
    rule: CliRule
    identity: Identity
    agent?: string
    steps: PaneStep[]
    factorFirst: boolean
    askPaths?: { flag: string; prompt: string }[]
    capture?: NonNullable<PaneSpec["capture"]>
    addsYes?: true
    /** `keys create`: the agent the new key is stored as, by the launcher. */
    newAgent?: string
    /** A rename the core planned: each wallet by address and its new name, so the core follows it when it finishes. */
    renames?: { address: string; name: string }[]
    /**
     * The factor step was left out because this machine has no vault and has never had one.
     * Read again when the pane starts: a vault there by then puts the factor back on.
     */
    noVault?: true
    /** The plan renewal the CLI pays for before the command: the pane says so before anything runs. */
    renews?: string
  }
}

export const FACTOR_ARGV: readonly string[] = ["vault", "status", "--unlock", "--json"]
export const PANE_NOTE = "Runs in a terminal pane the agent can't see. You answer the CLI's own prompts there."

/** A resolved call that runs in the pane, as the card book is asked for it. */
export interface PaneRequest {
  row: CliRow
  rule: CliRule
  identity: Identity
  agent?: string
  /** The words after `candle`, as the call resolved them. */
  words: string[]
  /** Whether the command takes `--rpc-url`. */
  rpcUrl: boolean
  /** The row's factor step, where the call decides it (`tee rename` of a known TEE wallet with a vault: the CLI asks). */
  factorFirst?: boolean
  /** `keys create`: the new agent's name. */
  newAgent?: string
  /** What the card says besides the steps: who it makes, what moves, what a preset drops. */
  notes?: string[]
  /** Why it can't run on this machine yet, and the step that fixes it (no vault: `vault init`). Approve is refused. */
  blocked?: { why: string; fill: Fill }
  /** A ceremony's line: what it shows or takes, read before the press. */
  shows?: string
  /**
   * Funds out to an address that isn't one of the user's own: in full, in groups of four. The
   * card shows it amber, and only a click approves it.
   */
  newAddress?: string
  /** What to read before the press, and the chips that type the step before it (`tee sweep`: disable it first). */
  warning?: string
  fills?: Fill[]
  /** The plan renewal the CLI pays for before this runs: on the card, and said again in the pane, where a typed line opens with no card. */
  renews?: string
  /** A batch rename: its `--dry-run` runs first, and the command only once the person types yes. */
  preview?: true
  /** A rename the core planned: each wallet by address and its new name. */
  renames?: { address: string; name: string }[]
  /** No vault and none ever seen here, so the row's factor step is left out, and the card says so. */
  noVault?: true
}

/** The words the agent proposed, made final: what the launcher runs. */
export function planPane(
  input: PaneRequest & {
    /** CandleCli.finalArgs: `--json` when asked, and the configured `--rpc-url` where taken. */
    finalArgs: (args: string[], opts: { json: boolean; rpcUrl: boolean }) => string[]
  },
): PaneParams {
  const spec = input.row.pane!
  // The words carry `--yes` only where the core added it (narrowing access answers its own
  // confirmation); the agent can't pass it. `profile remove` gets it here (it never prompts).
  const words = input.words.filter((w) => w !== "--json")
  if (spec.addsYes && !words.includes("--yes")) words.push("--yes")
  const command = input.finalArgs(words, { json: spec.capture !== undefined, rpcUrl: input.rpcUrl })
  const factorFirst = input.noVault ? false : (input.factorFirst ?? spec.factorFirst)
  const steps: PaneStep[] = [
    ...(factorFirst ? [{ stage: "factor" as const, argv: [...FACTOR_ARGV] }] : []),
    ...(input.preview ? [{ stage: "preview" as const, argv: [...command, "--dry-run"] }] : []),
    { stage: "command", argv: command },
  ]
  return {
    pane: {
      row: input.row.path,
      rule: input.rule,
      identity: input.identity,
      ...(input.identity === "agent" && input.agent ? { agent: input.agent } : {}),
      steps,
      factorFirst,
      ...(spec.askPaths?.length ? { askPaths: spec.askPaths.map((p) => ({ ...p })) } : {}),
      ...(spec.capture ? { capture: spec.capture } : {}),
      ...(spec.addsYes ? { addsYes: true as const } : {}),
      ...(input.newAgent ? { newAgent: input.newAgent } : {}),
      ...(input.renames?.length ? { renames: input.renames.map((r) => ({ ...r })) } : {}),
      ...(input.noVault ? { noVault: true as const } : {}),
      ...(input.renews ? { renews: input.renews } : {}),
    },
  }
}

/** The command a pane card runs, as the user reads it: the words, without what the core adds. */
export function paneCommand(params: PaneParams): string {
  const argv = params.pane.steps.at(-1)!.argv
  const at = argv.indexOf("--rpc-url")
  const shown = argv.filter((a, i) => a !== "--json" && a !== "--yes" && (at < 0 || (i !== at && i !== at + 1)))
  return terminalText(`candle ${shown.join(" ")}`, { maxLength: 160 })
}

/** The pane's title: what runs, that there's no vault where so, and that the agent can't see it. */
export function paneTitle(params: PaneParams): string {
  return `${paneCommand(params)}${params.pane.noVault ? ` · ${NO_VAULT_STEP}` : ""} · the agent can't see this pane`
}

const HEAD: Record<CliRule, string> = {
  owner: "OWNER",
  ceremony: "AT THE PROMPT",
  "funds-out": "FUNDS OUT",
  "less-access": "LESS ACCESS",
  read: "READ",
  card: "CARD",
  mcp: "MCP",
  never: "NEVER",
}

/** The card's title: what runs, in full. */
export function paneTitleLine(params: PaneParams): string {
  return `${HEAD[params.pane.rule]} · ${paneCommand(params)}`
}

/** The card's headline: the title with addresses shortened, so what happened fits beside it once it ends. */
export function paneHeadline(params: PaneParams): string {
  return paneTitleLine(params).replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, short)
}

/** A path asked in the pane that goes on the command line as a positional (`<path>`, `<file>`), not after a flag. */
export const isPositionalPath = (flag: string) => flag.startsWith("<")

/**
 * The launcher's own words, wrapped at spaces to the pane's width (unwrapped, at 120×30 a sentence broke
 * mid-word). Lines end `\r\n`, as the pane's terminal needs; colour codes take no width; a word wider than the pane
 * is left whole, for the terminal to break.
 */
export function wrapForPane(text: string, cols: number | undefined): string {
  if (!cols || cols < 20) return text
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length
  return text
    .split("\r\n")
    .map((line) => {
      const out: string[] = []
      let cur = ""
      for (const word of line.split(" ")) {
        if (cur !== "" && visible(cur) + 1 + visible(word) > cols) {
          out.push(cur)
          cur = word
        } else cur = cur === "" ? word : `${cur} ${word}`
      }
      out.push(cur)
      return out.join("\r\n")
    })
    .join("\r\n")
}

/**
 * A path as typed in the pane, for the command line: trimmed, with a leading `~` or `~/` as the user's home, as
 * their shell would. The launcher runs `candle` with no shell, so it
 * expands nothing else, and a `~name` is passed as typed.
 */
export function typedPath(value: string, home: string | undefined): string {
  const path = value.trim()
  if (!home || !(path === "~" || path.startsWith("~/"))) return path
  return `${home.replace(/\/+$/, "")}${path.slice(1)}`
}

/** What the user will be asked, in order, in words for the card. */
export function paneSteps(row: CliRow, params: PaneParams): string[] {
  const spec = row.pane!
  const out: string[] = []
  if (params.pane.noVault) out.push(`${NO_VAULT_STEP}: this machine has no vault, so there's no factor to ask for, and the agent can't type there`)
  else if (params.pane.factorFirst) out.push("your vault factor first (the Candle Harness asks the CLI to unlock, and nothing runs if it doesn't)")
  else if (spec.needsPrompt) out.push(spec.needsPrompt.replace(/\.$/, ""))
  if (params.pane.steps.some((s) => s.stage === "preview")) out.push("the CLI's preview of every rename first (nothing changes), then you type yes to make them")
  for (const path of params.pane.askPaths ?? []) out.push(`you'll name ${isPositionalPath(path.flag) ? "the file" : path.flag} in the pane`)
  out.push(...spec.confirms)
  return out
}

/** How a pane step ended, as the launcher reports it. */
export type PaneStage = "factor" | "paths" | "preview" | "command"
export interface PaneReport {
  stage: PaneStage
  exit?: number
  signal?: string
  /** The factor step's `code` when it refused. */
  code?: string
  stopped?: boolean
  /** A capture row's one reading (Global Constraints): a new key's prefix and agent, never the key; `vault status`'s code; `vault list`'s addresses and labels. */
  captured?: Captured
}

export interface Captured {
  /** `keys create`: the new key's prefix, the agent it was stored as, and whether it was. */
  prefix?: string
  agent?: string
  stored?: boolean
  /** `vault status`: its code. */
  code?: string
  /** `vault list`: each entry's address, label and role, and nothing else. */
  addresses?: { address: string; label?: string; role: "vault" | "tee-wallet" }[]
}

/**
 * What the agent and the card are told: the outcome only (Global Constraints). Besides the report's
 * own, `not_opened` (the ticket expired unredeemed: nothing ran) and `unknown` (the pane's connection
 * ended with no report).
 */
export type PaneOutcome = "finished" | "didnt_finish" | "usage" | "pending" | "stopped" | "refused_before" | "not_opened" | "unknown"

export interface PaneResult {
  outcome: PaneOutcome
  /** The outcome in words, for the card, the activity line and the agent. */
  words: string
  exit?: number
  signal?: string
  code?: string
  /** What to do next, as chips that put a command on the input line, never run by the core. */
  next?: Fill[]
}

const MAY_STILL_LAND = "may still land: check the signature before anything else"

/**
 * The outcome of a report, by its exit status (only the factor step reads `ok`). A row that may show a
 * secret once it starts (`reveals`) never says nothing was shown: a stop or an exit 1 after
 * the command started may come after the words were on the pane.
 */
export function paneOutcome(report: PaneReport, opts: { fundsOut: boolean; reveals?: string; exit3?: string }): PaneResult {
  const base = { ...(report.exit !== undefined ? { exit: report.exit } : {}), ...(report.signal ? { signal: report.signal } : {}), ...(report.code ? { code: report.code } : {}) }
  if (report.stage === "factor" && !report.stopped) {
    const why =
      report.code === "VAULT_MISSING"
        ? "no vault on this machine: set one up with candle vault init, then ask again"
        : report.code === "VAULT_UNLOCK_FAILED"
          ? "the passphrase didn't open the vault"
          : `the vault didn't unlock (${report.code ?? `exit ${report.exit ?? "?"}`})`
    return { outcome: "refused_before", words: `${why}. Nothing was run.`, ...base }
  }
  // A batch rename's preview: the CLI's --dry-run changes nothing, so neither does a refusal or a no.
  if (report.stage === "preview" && !report.signal) {
    if (report.stopped) return { outcome: "stopped", words: "stopped after the preview, before anything was renamed. Nothing changed.", ...base }
    if (report.exit === 2) return { outcome: "usage", words: "the CLI refused the command line (exit 2): a fault in the Candle Harness's command table. Nothing changed.", ...base }
    return { outcome: "refused_before", words: "the CLI's preview refused it, so nothing was renamed: its reasons are in the pane.", ...base }
  }
  if (report.stopped || report.signal) {
    if (report.stage !== "command") return { outcome: "stopped", words: "stopped in the pane before the command ran. Nothing was run.", ...base }
    if (opts.fundsOut) return { outcome: "stopped", words: `stopped in the pane, and ${MAY_STILL_LAND}.`, ...base }
    return { outcome: "stopped", words: `stopped in the pane before it finished.${opts.reveals ? ` It may have shown ${opts.reveals}.` : ""}`, ...base }
  }
  switch (report.exit) {
    case 0:
      return { outcome: "finished", words: "finished in the pane.", ...base }
    case 2:
      return { outcome: "usage", words: "the CLI refused the command line (exit 2): a fault in the Candle Harness's command table. Nothing was run.", ...base }
    case 3:
      return { outcome: "pending", words: opts.exit3 ?? `not confirmed yet (exit 3): it ${MAY_STILL_LAND}.`, ...base }
    default:
      if (opts.reveals) return { outcome: "didnt_finish", words: `didn't finish: it may have shown ${opts.reveals} before it stopped.`, ...base }
      // A send can fail after it was signed and sent, so its words never say nothing went out.
      if (opts.fundsOut) return { outcome: "didnt_finish", words: `didn't finish (exit ${report.exit ?? "?"}): refused, answered no, or failed partway. Check the wallet or the signature before sending again.`, ...base }
      return { outcome: "didnt_finish", words: "didn't finish: the CLI's own line above says why (a wrong passphrase, a refusal, or no at its prompt).", ...base }
  }
}

/** How many keys `vault list` made known, by kind, in the same words on the pane and in its outcome: "1 vault key and 1 TEE wallet". */
export function vaultListCount(vaultKeys: number, teeWallets: number): string {
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
  const parts = [...(vaultKeys > 0 || teeWallets === 0 ? [part(vaultKeys, "vault key")] : []), ...(teeWallets > 0 ? [part(teeWallets, "TEE wallet")] : [])]
  return parts.join(" and ")
}

/** The words standing alone, on the pane and its footer, as a sentence: elsewhere they follow the command ("…: the passphrase didn't…"). */
export const asSentence = (words: string): string => (words ? words[0]!.toUpperCase() + words.slice(1) : words)

/**
 * `tee disable` and `tee sweep` finished: what each means, since "finished" reads as
 * a pause. The CLI never re-enables a TEE wallet, and a swept address is retired.
 */
export const STOPPED_FOR_GOOD = "stopped for good: Candle never re-enables a stopped TEE wallet. Its funds stay in it until you sweep it home, then a new TEE wallet takes its place."
export const SWEPT_AND_RETIRED = "swept: everything it held went to its pinned vault, and the CLI retired the address, so it's never used again."

/** No report: the ticket expired before any pane redeemed it. */
export const NOT_OPENED: PaneResult = { outcome: "not_opened", words: "the pane never opened in time. Nothing was run." }
/** No report: the pane's connection ended first (the launcher was killed, or the view went). */
export const NO_REPORT: PaneResult = { outcome: "unknown", words: "the pane closed before it said how the step ended: check what it would have changed before asking again." }

/**
 * A pane outcome as an operation's state, for the journal and the agent's record. Nothing is ever
 * re-sent: `unknown` here is the user's to check, never the core's to read back (execute.ts).
 */
export function paneMapped(result: PaneResult, opts: { fundsOut: boolean }): Mapped {
  const pane = { pane: result }
  const error = (code: string) => ({ code, message: result.words, retryable: false })
  switch (result.outcome) {
    case "finished":
      return { state: "succeeded", result: pane }
    case "didnt_finish":
      return { state: "failed", result: pane, error: error("PANE_DIDNT_FINISH") }
    case "usage":
      return { state: "failed", result: pane, error: error("CLI_USAGE") }
    case "pending":
      return { state: "unknown", result: pane, reason: result.words }
    case "stopped":
      return opts.fundsOut ? { state: "unknown", result: pane, reason: result.words } : { state: "failed", result: pane, error: error("PANE_STOPPED") }
    case "refused_before":
      return { state: "refused", result: pane, error: error(result.code ?? "FACTOR_REFUSED") }
    case "not_opened":
      return { state: "refused", result: pane, error: error("PANE_NOT_OPENED") }
    case "unknown":
      return { state: "unknown", result: pane, reason: result.words }
  }
}
