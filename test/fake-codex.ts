// A stand-in for the `codex` binary, so `bun test` needs no Codex installed. It answers
// `--version` and `debug models`, and `exec` replays a recorded stream (test/fixtures/engine/codex*.jsonl).
// What it was run with is logged for the tests to read: its arguments, the prompt on stdin, CODEX_HOME,
// RUST_LOG, and what the private home held.
//
// `fakeCodex(o)` writes a `codex` wrapper that sets the behaviour and runs this file, since an engine
// turn's environment is cut down to harnessEnv's allowlist and can't carry it.
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FIXTURES = join(import.meta.dir, "fixtures/engine")

export interface FakeCodex {
  /** The fixture `exec` replays, by name: "codex", "codex-signedout", "codex-ratelimit"… */
  fixture?: string
  /** What `--version` prints. */
  version?: string
  /** A file of stderr lines `exec` writes first (codex-ratelimit.stderr). */
  stderr?: string
  /** Milliseconds between replayed lines. */
  delayMs?: number
  /** After replaying, wait (a turn that never ends on its own) or die. */
  after?: "exit" | "hang" | "die"
  /** During `exec`, replace the private home's auth.json with a new file, as a token rotation would. */
  rotateAuth?: string
}

/** A folder holding `codex`, which runs this fake with `o`, and the log it writes (one JSON line a run). */
export function fakeCodex(o: FakeCodex = {}): { bin: string; dir: string; log: string; runs(): FakeRun[] } {
  const dir = mkdtempSync(join(tmpdir(), "chrn-fake-codex-"))
  const log = join(dir, "runs.jsonl")
  const bin = join(dir, "codex")
  writeFileSync(bin, `#!/bin/sh\nFAKE_CODEX=${shq(JSON.stringify(o))} FAKE_CODEX_LOG=${shq(log)} exec ${shq(process.execPath)} ${shq(import.meta.path)} "$@"\n`)
  chmodSync(bin, 0o755)
  return { bin, dir, log, runs: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeRun) : []) }
}

export interface FakeRun {
  argv: string[]
  stdin: string
  env: { CODEX_HOME?: string; RUST_LOG?: string; HOME?: string; CANDLE_HARNESS_TURN?: string }
  /** The private home's entries, with each one's kind and, for a link, where it points. */
  home: { name: string; link?: string; file?: boolean }[]
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

function homeListing(home: string | undefined): FakeRun["home"] {
  if (!home || !existsSync(home)) return []
  return readdirSync(home).map((name) => {
    const st = lstatSync(join(home, name))
    return st.isSymbolicLink() ? { name, link: readlinkSync(join(home, name)) } : { name, file: st.isFile() }
  })
}

async function main(): Promise<void> {
  const o = JSON.parse(process.env.FAKE_CODEX ?? "{}") as FakeCodex
  const args = process.argv.slice(2)
  const record = (stdin: string) => {
    const run: FakeRun = {
      argv: args,
      stdin,
      env: { CODEX_HOME: process.env.CODEX_HOME, RUST_LOG: process.env.RUST_LOG, HOME: process.env.HOME, CANDLE_HARNESS_TURN: process.env.CANDLE_HARNESS_TURN },
      home: homeListing(process.env.CODEX_HOME),
    }
    if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(run)}\n`)
  }
  if (args[0] === "--version") {
    record("")
    console.log(o.version ?? "codex-cli 0.165.0")
    return
  }
  if (args[0] === "debug" && args[1] === "models") {
    record("")
    process.stdout.write(readFileSync(join(FIXTURES, "codex-models.json"), "utf8"))
    return
  }
  if (args[0] !== "exec") {
    console.error(`fake codex: unknown command ${args.join(" ")}`)
    process.exit(2)
  }
  const stdin = args.at(-1) === "-" ? await new Response(Bun.stdin.stream()).text() : ""
  record(stdin)
  if (o.rotateAuth !== undefined && process.env.CODEX_HOME) {
    const auth = join(process.env.CODEX_HOME, "auth.json")
    writeFileSync(`${auth}.new`, o.rotateAuth)
    renameSync(`${auth}.new`, auth) // write-then-rename replaces the link with a file
  }
  if (o.stderr) process.stderr.write(readFileSync(join(FIXTURES, o.stderr), "utf8"))
  for (const line of readFileSync(join(FIXTURES, `${o.fixture ?? "codex"}.jsonl`), "utf8").split("\n").filter(Boolean)) {
    console.log(line)
    if (o.delayMs) await Bun.sleep(o.delayMs)
  }
  if (o.after === "hang") await Bun.sleep(600_000)
  if (o.after === "die") process.kill(process.pid, "SIGKILL")
}

if (import.meta.main) await main()
