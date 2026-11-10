// `candle-harness cli-pane`: the prompt pane's launcher. The view starts it
// in a terminal pane of its own, with a single-use ticket in CANDLE_HARNESS_PANE_TICKET and the core's
// socket in CANDLE_HARNESS_PANE_SOCKET. With no vault on the machine there's no
// factor step, and it says so before anything runs. It:
//   1. drops both from its environment, says hello with the ticket (role `pane`) and redeems it, once,
//      for exactly what the card showed: the steps, the identity and, for an agent's row, its key;
//   2. runs the factor step, if any (`vault status --unlock --json`): the prompt on the pane, stdout
//      piped. Only `ok: true` counts as unlocked, and anything else runs nothing;
//   3. asks the user on the pane for any path the agent may not give;
//   4. runs the command with the pane as its terminal (stdout piped only for the three capture rows),
//      ignoring SIGINT itself so a Ctrl-C reaches `candle` alone;
//   5. reports the outcome, by exit status, and prints it.
//
// Keystrokes go from the terminal to `candle` only: the launcher reads the pane's input just for a
// path, and never sends a byte of the pane to the core. At a hidden prompt Ctrl-C is a byte the CLI
// ignores (it spins until a SIGTERM), so the view, which sees the byte go in, sends the
// launcher SIGUSR1 a second later and the launcher ends `candle` with SIGTERM. A hangup (the pane
// closed) does the same, then reports `stopped`.
import { readSync, writeSync } from "node:fs"
import { rpcToEnv, RPC_URL_ENV } from "../core/candle-cli"
import { type CoreConnection, connectCore } from "../core/client"
import { asSentence, type Captured, isPositionalPath, typedPath, vaultListCount, wrapForPane } from "../core/pane-plan"
import { restoreLoginEnv } from "../main"
import { paths } from "../paths"
import { storeNewAgentKey } from "../setup/key-add"
import { terminalText } from "../shared/terminal-text"
import { StderrRelay } from "./owner-confirm"

import { PANE_SOCKET_ENV, PANE_TICKET_ENV } from "../view/pane-process"

export { PANE_SOCKET_ENV, PANE_TICKET_ENV }

/** What `pane.redeem` answers. */
export interface Redeemed {
  title: string
  bin: string
  steps: { stage: "factor" | "preview" | "command"; argv: string[] }[]
  identity: "agent" | "owner"
  agent?: string
  askPaths?: { flag: string; prompt: string }[]
  capture?: "code" | "addresses" | "new-key"
  fundsOut?: boolean
  /** No vault on this machine: there's no factor step, and the pane says so first. */
  noVault?: boolean
  /** The plan renewal the CLI pays for before the command, said before anything runs. */
  renews?: string
  /** `keys create`: the agent the new key is stored as, and the core's home, where it goes. */
  newAgent?: string
  home?: string
  apiKey?: string
  /** The CLI profile the Candle Harness acts as: `candle` runs as it, as the core's runs do. */
  profile?: string
  /** Onboarding's harness sign-in: the harness's own command from the fixed list, as the person. */
  harness?: string
  /** Said before a harness's sign-in runs: what to type there (Pi's /login). */
  note?: string
}

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const ADDRESS = /^(0x[0-9a-fA-F]{40}|[0-9A-Za-z]{32,44})$/

/**
 * A capture row's one reading, from the command's piped stdout. A new
 * key goes into the key file as the card's agent and nowhere else: only its prefix, the agent and
 * whether it was stored go back. `vault status`'s code goes back. From `vault list`, each
 * entry's address, label and role go back, and nothing else of it. Anything else is dropped.
 */
export async function captureOf(redeemed: Pick<Redeemed, "capture" | "newAgent" | "home">, stdout: string): Promise<Captured | undefined> {
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>
  } catch {
    return undefined
  }
  // A refusal in --json goes to the stdout the pane pipes, so it would show nothing (keys create would end
  // "Didn't finish" with no reason on screen). Its words are said; the key, when there is one, never is.
  if (redeemed.capture !== "code" && typeof parsed?.key !== "string") sayRefusal(parsed)
  if (redeemed.capture === "code") return typeof parsed?.code === "string" && CODE.test(parsed.code) ? { code: parsed.code } : undefined
  if (redeemed.capture === "addresses") {
    if (!Array.isArray(parsed?.entries)) return undefined
    const addresses = (parsed.entries as Record<string, unknown>[]).slice(0, 500).flatMap((e) => {
      const address = typeof e?.address === "string" && ADDRESS.test(e.address) ? e.address : undefined
      const role = e?.role === "vault" || e?.role === "tee-wallet" ? (e.role as "vault" | "tee-wallet") : undefined
      if (!address || !role) return []
      const label = typeof e.label === "string" && e.label.length <= 64 && !/[\x00-\x1f\x7f]/.test(e.label) ? e.label : undefined
      return [{ address, ...(label !== undefined ? { label } : {}), role }]
    })
    const count = vaultListCount(addresses.filter((a) => a.role === "vault").length, addresses.filter((a) => a.role === "tee-wallet").length)
    tell(`${BOLD}Kept as places funds may go: ${count}, addresses and labels only.${RESET}\r\n`)
    return { addresses }
  }
  if (redeemed.capture !== "new-key" || !redeemed.newAgent || !redeemed.home) return undefined
  // The CLI prints the key even when its own store failed (exit 1, commands/keys.ts): it's made either way.
  const key = typeof parsed?.key === "string" ? parsed.key : undefined
  // No key made: Candle's code goes back, so setup can say what to do (such as a new account's wallet not yet authorized).
  if (key === undefined) {
    // Candle's docs name the code; the words carry it too, in case a refusal comes back as a bare HTTP code.
    const code = typeof parsed?.message === "string" && /not delegated/i.test(parsed.message) ? "AGENT_WALLET_NOT_DELEGATED" : parsed?.code
    return typeof code === "string" && CODE.test(code) ? { agent: redeemed.newAgent, stored: false, code } : undefined
  }
  let stored: Awaited<ReturnType<typeof storeNewAgentKey>>
  try {
    // Where the core keeps its keys, as it said: never the pane's own environment, which drops CANDLE_HARNESS_HOME.
    stored = await storeNewAgentKey(paths({ CANDLE_HARNESS_HOME: redeemed.home }), redeemed.newAgent, key)
  } catch (error) {
    stored = { ok: false, why: error instanceof Error ? error.message : String(error) }
  }
  if (stored.ok) tell(`${BOLD}Made key ${stored.prefix}… and stored it as ${redeemed.newAgent}.${RESET} No copy is shown.\r\n`)
  else tell(`${BOLD}A key was made${stored.prefix ? ` (${stored.prefix}…)` : ""}, but the Candle Harness didn't store it: ${stored.why}.${RESET}\r\n`)
  return { agent: redeemed.newAgent, stored: stored.ok, ...(stored.prefix ? { prefix: stored.prefix } : {}) }
}

/**
 * What the CLI said when it refused a captured row (`{ok: false, code, message, suggestion}`): those three
 * fields only, cleaned of control characters, anything shaped like a Candle key cut to its start, and kept short.
 */
export function refusalWords(parsed: Record<string, unknown> | undefined): string | undefined {
  if (!parsed || (parsed.ok !== false && typeof parsed.code !== "string")) return undefined
  const field = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string).replace(/[\x00-\x1f\x7f]+/g, " ").trim() : "")
  const code = CODE.test(field("code")) ? field("code") : ""
  const text = [field("message"), field("suggestion")].filter(Boolean).join(" ")
  if (!code && !text) return undefined
  const words = `${code}${code && text ? ": " : ""}${text}`.replace(/cndl_[A-Za-z0-9_-]+/g, "cndl_…")
  return words.length > 600 ? `${words.slice(0, 599)}…` : words
}

function sayRefusal(parsed: Record<string, unknown> | undefined): void {
  const words = refusalWords(parsed)
  if (words) tell(`${BOLD}The CLI said:${RESET} ${words}\r\n`)
}

/** Variables `candle` never gets from the pane: ours, and the ones that change who it runs as. The person's CANDLE_KEYRING_PASSPHRASE stays, so the CLI can open its file store where there's no keychain. */
const STRIPPED = /^(CANDLE_(HARNESS|TUI)_.*|CANDLE_API_KEY|CANDLE_DEVICE_TOKEN)$/

/** `candle`'s environment: the pane's own, less what's stripped, plus the agent's key for an agent's row. */
export function candleEnv(env: Record<string, string | undefined>, redeemed: Pick<Redeemed, "identity" | "apiKey" | "profile" | "harness">): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !STRIPPED.test(key)) out[key] = value
  restoreLoginEnv(out)
  // A harness's sign-in is the person's own, in their own environment: nothing of Candle's goes with it.
  if (redeemed.harness) {
    for (const key of Object.keys(out)) if (key.startsWith("CANDLE_")) delete out[key]
    return out
  }
  out.CANDLE_NO_UPDATE_NOTIFIER = "1"
  if (redeemed.profile) out.CANDLE_PROFILE = redeemed.profile
  if (redeemed.identity === "agent" && redeemed.apiKey) out.CANDLE_API_KEY = redeemed.apiKey
  return out
}

const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

function say(text: string): void {
  writeSync(1, text)
}

/** The launcher's own sentences, wrapped to the pane at spaces. */
function tell(text: string): void {
  say(wrapForPane(text, process.stdout.columns))
}

/** The terminal's settings, to put back after every step (a stopped prompt must leave it working). */
function sttyGet(): string | undefined {
  const r = Bun.spawnSync(["stty", "-g"], { stdin: "inherit", stdout: "pipe", stderr: "ignore" })
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined
}

function sttySet(...args: string[]): void {
  Bun.spawnSync(["stty", ...args], { stdin: "inherit", stdout: "ignore", stderr: "ignore" })
}

/**
 * One visible line from the pane, read synchronously so no reader is left on the terminal for `candle`
 * to compete with. Ctrl-C (or Ctrl-D on an empty line) is undefined: the user backed out.
 */
export function readLine(prompt: string): string | undefined {
  // Raw before the prompt shows: a key pressed as soon as it appears must reach this read. Typed into the cooked
  // terminal, a Ctrl-C would be a SIGINT the launcher ignores, and it flushes what was typed, so the pane hung.
  const saved = sttyGet()
  sttySet("raw", "-echo")
  say(prompt)
  let line = ""
  const byte = Buffer.alloc(1)
  try {
    for (;;) {
      let n = 0
      try {
        n = readSync(0, byte, 0, 1, null)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN" || (error as NodeJS.ErrnoException).code === "EINTR") continue
        return undefined
      }
      if (n === 0) return undefined
      const b = byte[0]!
      if (b === 0x03 || (b === 0x04 && line === "")) {
        say("\r\n")
        return undefined
      }
      if (b === 0x0d || b === 0x0a) {
        say("\r\n")
        return line
      }
      if (b === 0x7f || b === 0x08) {
        if (line.length > 0) {
          line = line.slice(0, -1)
          say("\b \b")
        }
        continue
      }
      if (b >= 0x20 && b < 0x7f) {
        line += String.fromCharCode(b)
        say(String.fromCharCode(b))
      }
    }
  } finally {
    if (saved) sttySet(saved)
    else sttySet("sane")
  }
}

/** A command's stderr onto the pane as it comes, with Candle's browser confirm said in words. */
async function relayStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const relay = new StderrRelay((text) => writeSync(2, text))
  const decoder = new TextDecoder()
  for await (const chunk of stream) relay.push(decoder.decode(chunk, { stream: true }))
  relay.push(decoder.decode())
  relay.end()
}

interface Running {
  proc: Bun.Subprocess
  stopped: boolean
}

/** Runs the launcher in this process. Returns its exit status. */
export async function runLauncher(env: Record<string, string | undefined> = process.env, deps: { connect?: typeof connectCore } = {}): Promise<number> {
  const ticket = env[PANE_TICKET_ENV]
  const socketPath = env[PANE_SOCKET_ENV]
  // Gone before anything else runs, so no child of ours ever sees them.
  delete env[PANE_TICKET_ENV]
  delete env[PANE_SOCKET_ENV]
  if (process.env !== env) {
    delete process.env[PANE_TICKET_ENV]
    delete process.env[PANE_SOCKET_ENV]
  }
  if (!ticket || !socketPath) {
    say("candle-harness cli-pane is started by the Candle Harness's view, for a card you approved there.\r\n")
    return 2
  }

  let connection: CoreConnection
  let redeemed: Redeemed
  try {
    connection = (await (deps.connect ?? connectCore)({ socketPath, token: ticket, clientName: "prompt pane" })).connection
    redeemed = await connection.request<Redeemed>("pane.redeem")
  } catch (error) {
    say(`The pane couldn't start: ${error instanceof Error ? error.message : String(error)}\r\nNothing was run.\r\n`)
    return 1
  }

  const childEnv = candleEnv(env, redeemed)
  // The key now lives in childEnv only.
  delete redeemed.apiKey
  const saved = sttyGet()
  let running: Running | undefined
  let reported = false

  const report = async (body: Record<string, unknown>): Promise<{ outcome?: string; words?: string }> => {
    reported = true
    try {
      return await connection.request("pane.report", body)
    } catch (error) {
      return { words: `the Candle Harness didn't take the outcome (${error instanceof Error ? error.message : String(error)}).` }
    }
  }

  // Ctrl-C belongs to `candle` while it runs; the launcher ignores it.
  const onInt = () => {}
  // The view's stop (after a Ctrl-C byte at a prompt that ignored it): end `candle`.
  const onStop = () => {
    if (running) {
      running.stopped = true
      running.proc.kill("SIGTERM")
    }
  }
  // The pane closed: end `candle`, say so, and go.
  const onHangup = () => {
    onStop()
    if (!running && !reported) void report({ stage: "command", stopped: true, signal: "SIGHUP" }).finally(() => process.exit(129))
  }
  process.on("SIGINT", onInt)
  process.on("SIGUSR1", onStop)
  process.on("SIGHUP", onHangup)
  process.on("SIGTERM", onHangup)

  const run = async (argv: string[], piped: boolean, relay = false): Promise<{ exit?: number; signal?: string; stopped: boolean; stdout: string }> => {
    // The RPC from config goes in the CLI's own variable, not on a command line other users can read.
    const moved = rpcToEnv(argv)
    const env = moved.rpcUrl !== undefined ? { ...childEnv, [RPC_URL_ENV]: moved.rpcUrl } : childEnv
    // A captured command runs with --json, where Candle's browser confirm is a JSON line on stderr: relayed, it's said in words.
    const proc = Bun.spawn([redeemed.bin, ...moved.argv], { env, stdin: "inherit", stdout: piped ? "pipe" : "inherit", stderr: relay ? "pipe" : "inherit" })
    running = { proc, stopped: false }
    const out = piped ? new Response(proc.stdout as ReadableStream).text() : Promise.resolve("")
    const relayed = relay ? relayStderr(proc.stderr as ReadableStream<Uint8Array>) : Promise.resolve()
    const exit = await proc.exited
    const stdout = await out
    await relayed
    const stopped = running.stopped
    running = undefined
    if (saved) sttySet(saved)
    const signal = typeof proc.signalCode === "string" ? proc.signalCode : undefined
    return { ...(signal ? { signal } : { exit }), stopped, stdout }
  }

  let body: Record<string, unknown> | undefined
  if (redeemed.harness) tell(`${BOLD}Your own sign-in, as you: it goes into the harness's own store, and the Candle Harness keeps none of it.${RESET}\r\n${redeemed.note ? `${redeemed.note}\r\n` : ""}\r\n`)
  if (redeemed.noVault) tell(`${BOLD}No vault on this machine, so there's no factor to ask for: you approve this here, and the agent can't type in this pane.${RESET}\r\n`)
  if (redeemed.renews) tell(`${BOLD}${terminalText(redeemed.renews, { maxLength: 600 })}${RESET} Press Ctrl-C to stop before it pays.\r\n`)
  try {
    for (const step of redeemed.steps) {
      if (step.stage === "factor") {
        const r = await run(step.argv, true)
        let parsed: { ok?: unknown; code?: unknown } | undefined
        try {
          parsed = JSON.parse(r.stdout)
        } catch {
          parsed = undefined
        }
        // Only `ok: true` unlocks: an exit with nothing written, as after a stopped prompt, fails like any code.
        if (r.exit === 0 && parsed?.ok === true) continue
        const code = typeof parsed?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.code) ? parsed.code : undefined
        body = { stage: "factor", ...(r.exit !== undefined ? { exit: r.exit } : {}), ...(r.signal ? { signal: r.signal } : {}), ...(code ? { code } : {}), ...(r.stopped || r.signal ? { stopped: true } : {}) }
        break
      }
      // A batch rename's preview: the CLI's --dry-run, on the pane, then a typed yes. Anything else stops with nothing changed.
      if (step.stage === "preview") {
        const r = await run(step.argv, false)
        if (r.exit !== 0 || r.signal || r.stopped) {
          body = { stage: "preview", ...(r.exit !== undefined ? { exit: r.exit } : {}), ...(r.signal ? { signal: r.signal } : {}), ...(r.stopped ? { stopped: true } : {}) }
          break
        }
        const answer = readLine(`${BOLD}Make these renames? Type yes:${RESET} `)
        if (answer?.trim().toLowerCase() !== "yes") {
          body = { stage: "preview", stopped: true }
          break
        }
        continue
      }
      const argv = [...step.argv]
      let backedOut = false
      for (const path of redeemed.askPaths ?? []) {
        let value: string | undefined
        do value = readLine(`${BOLD}${path.prompt}:${RESET} `)
        while (value !== undefined && value.trim() === "")
        if (value === undefined) {
          backedOut = true
          break
        }
        // The path goes on the command line, and nowhere else: `~` as the user's home, since no shell expands it.
        const typed = typedPath(value, process.env.HOME)
        if (isPositionalPath(path.flag)) argv.push(typed)
        else argv.push(path.flag, typed)
      }
      if (backedOut) {
        body = { stage: "paths", stopped: true }
        break
      }
      const r = await run(argv, redeemed.capture !== undefined, redeemed.capture !== undefined)
      const captured = redeemed.capture !== undefined ? await captureOf(redeemed, r.stdout) : undefined
      body = { stage: "command", ...(r.exit !== undefined ? { exit: r.exit } : {}), ...(r.signal ? { signal: r.signal } : {}), ...(r.stopped ? { stopped: true } : {}), ...(captured ? { captured } : {}) }
    }
  } finally {
    process.off("SIGINT", onInt)
    if (saved) sttySet(saved)
  }
  const answer = await report(body ?? { stage: "command", exit: 0 })
  process.off("SIGUSR1", onStop)
  process.off("SIGHUP", onHangup)
  process.off("SIGTERM", onHangup)
  connection.close()
  tell(`\r\n${BOLD}${answer.words ? asSentence(answer.words) : "Done."}${RESET}\r\n`)
  return 0
}
