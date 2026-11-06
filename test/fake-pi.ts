// A stand-in for the `pi` binary, so `bun test` needs no Pi installed. It answers
// `--version`, `--list-models` and `auth check`, and a turn replays a recorded stream
// (test/fixtures/engine/pi*.jsonl). As real Pi does, it loads the extensions named with `-e` before
// anything else and refuses to start when one is missing or throws, so the engine's gate really loads;
// with `call`, it runs one tool call through the loaded gate and logs what the gate did. What it was run
// with (argv, folder, environment, stdin, the private agent folder) is logged for the tests.
//
// `fakePi(o)` writes a `pi` wrapper that sets the behaviour and runs this file, since an engine turn's
// environment is cut down to harnessEnv's allowlist and can't carry it.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FIXTURES = join(import.meta.dir, "fixtures/engine")

export interface FakePi {
  /** The fixture a turn replays, by name: "pi", "pi-refused", "pi-fail", "pi-cancel". */
  fixture?: string
  /** What `--version` prints. */
  version?: string
  /** What `--list-models` prints: the recorded table by default. */
  models?: string
  /** `auth check`'s authType for each provider asked about; one not named is `api_key`. */
  kinds?: Record<string, string>
  /** Milliseconds between replayed lines. */
  delayMs?: number
  /** After replaying, end, keep running (a turn that never ends on its own), or die. */
  after?: "end" | "hang" | "die"
  /** One tool call run through the loaded gate before the replay. */
  call?: { tool: string; input: Record<string, unknown> }
}

export interface FakePiRun {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  stdin?: string
  /** The private agent folder's files: a link's target, else the file's text. */
  agentDir?: Record<string, { link: string } | { text: string }>
  /** What the gate did with `call`: blocked with a reason, or passed with the input as the tool would get it. */
  gate?: { block?: boolean; reason?: string; input?: Record<string, unknown> }
  /** The tools the gate registered. */
  tools?: string[]
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** A folder holding `pi`, which runs this fake with `o`, and the runs it logged. */
export function fakePi(o: FakePi = {}): { bin: string; dir: string; runs(): FakePiRun[] } {
  const dir = mkdtempSync(join(tmpdir(), "chrn-fake-pi-"))
  const log = join(dir, "runs.jsonl")
  const bin = join(dir, "pi")
  writeFileSync(bin, `#!/bin/sh\nFAKE_PI=${shq(JSON.stringify(o))} FAKE_PI_LOG=${shq(log)} FAKE_PI_HOME="$HOME" HOME=${shq(dir)} exec ${shq(process.execPath)} ${shq(import.meta.path)} "$@"\n`)
  chmodSync(bin, 0o755)
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakePiRun) : [])
  return { bin, dir, runs }
}

const ENV_LOGGED = ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "CANDLE_HARNESS_RESEARCH_DIR", "CANDLE_HARNESS_TURN", "OPENROUTER_API_KEY"]

function agentFiles(dir: string | undefined): FakePiRun["agentDir"] {
  if (!dir || !existsSync(dir)) return undefined
  const out: NonNullable<FakePiRun["agentDir"]> = {}
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    out[name] = lstatSync(p).isSymbolicLink() ? { link: readlinkSync(p) } : { text: readFileSync(p, "utf8") }
  }
  return out
}

async function main(): Promise<void> {
  const o = JSON.parse(process.env.FAKE_PI ?? "{}") as FakePi
  const args = process.argv.slice(2)
  const env: Record<string, string | undefined> = { PID: String(process.pid) }
  for (const k of ENV_LOGGED) env[k] = k === "HOME" ? process.env.FAKE_PI_HOME : process.env[k]
  const run: FakePiRun = { argv: args, cwd: process.cwd(), env, agentDir: agentFiles(process.env.PI_CODING_AGENT_DIR) }
  const log = () => process.env.FAKE_PI_LOG && appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify(run)}\n`)

  if (args[0] === "--version") {
    log()
    return void console.log(o.version ?? "1.4.0")
  }
  if (args[0] === "--list-models") {
    log()
    return void process.stdout.write(o.models ?? readFileSync(join(FIXTURES, "pi-models.txt"), "utf8"))
  }
  if (args[0] === "auth" && args[1] === "check") {
    log()
    const provider = args[args.indexOf("--provider") + 1]!
    return void console.log(JSON.stringify({ status: "ready", provider, authType: o.kinds?.[provider] ?? "api_key" }))
  }
  if (!args.includes("--mode")) {
    log()
    console.error(`fake pi: unknown command ${args.join(" ")}`)
    process.exit(2)
  }

  // Real Pi loads every -e extension first, and won't start if one is missing or throws as it loads.
  const handlers: ((e: unknown) => Promise<unknown>)[] = []
  const tools: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-e" || args[i + 1]!.startsWith("builtin:")) continue
    const path = args[i + 1]!
    try {
      if (!existsSync(path)) throw new Error(`Extension path does not exist: ${path}`)
      const mod = await import(path)
      await mod.default({ on: (event: string, h: (e: unknown) => Promise<unknown>) => event === "tool_call" && handlers.push(h), registerTool: (t: { name: string }) => tools.push(t.name) })
    } catch (error) {
      log()
      console.error(`Error: Failed to load extension "${path}": ${(error as Error).message}`)
      process.exit(1)
    }
  }
  run.tools = tools
  run.stdin = await new Response(Bun.stdin.stream()).text()
  if (o.call) {
    const event = { toolName: o.call.tool, input: { ...o.call.input } }
    let result: { block?: boolean; reason?: string } | undefined
    for (const h of handlers) result = ((await h(event)) as typeof result) ?? result
    run.gate = result?.block ? result : { input: event.input }
  }
  log()
  for (const line of readFileSync(join(FIXTURES, `${o.fixture ?? "pi"}.jsonl`), "utf8").split("\n").filter(Boolean)) {
    process.stdout.write(`${line}\n`)
    if (o.delayMs) await Bun.sleep(o.delayMs)
  }
  if (o.after === "die") {
    await Bun.sleep(100)
    process.kill(process.pid, "SIGKILL")
  }
  if (o.after === "hang") await new Promise(() => {})
}

if (import.meta.main) await main()
