// A stand-in for the `grok` binary, so `bun test` needs no Grok installed. It answers
// `--version` and `models`, and a turn replays a recorded stream (test/fixtures/engine/grok*.jsonl), after
// writing the sandbox log real Grok writes as it applies a profile. What it was run with is logged for the
// tests to read: its arguments, the prompt file's text, HOME and GROK_HOME, and what the private home held.
//
// `fakeGrok(o)` writes a `grok` wrapper that sets the behaviour and runs this file, since an engine turn's
// environment is cut down to harnessEnv's allowlist and can't carry it.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FIXTURES = join(import.meta.dir, "fixtures/engine")

export interface FakeGrok {
  /** The fixture a turn replays, by name: "grok", "grok-signedout", "grok-cancel". */
  fixture?: string
  /** What `--version` prints. */
  version?: string
  /** Milliseconds between replayed lines. */
  delayMs?: number
  /** After replaying, wait (a turn that never ends on its own) or die. */
  after?: "exit" | "hang" | "die"
  /** During a turn, replace the private home's auth.json with a new file, as a token refresh would. */
  rotateAuth?: string
  /** The sandbox log a turn writes: enforced (as real Grok), unenforced, or none at all. */
  sandbox?: "enforced" | "unenforced" | "none"
}

/** A folder holding `grok`, which runs this fake with `o`, and the log it writes (one JSON line a run). */
export function fakeGrok(o: FakeGrok = {}): { bin: string; dir: string; log: string; runs(): FakeGrokRun[] } {
  const dir = mkdtempSync(join(tmpdir(), "chrn-fake-grok-"))
  const log = join(dir, "runs.jsonl")
  const bin = join(dir, "grok")
  // Bun writes a .bun folder into HOME, and a turn's HOME is the private home, so the fake runs with its
  // own and logs the one it was given.
  writeFileSync(bin, `#!/bin/sh\nFAKE_GROK=${shq(JSON.stringify(o))} FAKE_GROK_LOG=${shq(log)} FAKE_GROK_HOME="$HOME" HOME=${shq(dir)} exec ${shq(process.execPath)} ${shq(import.meta.path)} "$@"\n`)
  chmodSync(bin, 0o755)
  return { bin, dir, log, runs: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeGrokRun) : []) }
}

export interface FakeGrokRun {
  argv: string[]
  /** The prompt file's text, when there was one. */
  prompt: string
  env: { HOME?: string; GROK_HOME?: string; GROK_MEMORY?: string; GROK_WORKFLOWS?: string; GROK_DISABLE_AUTOUPDATER?: string; CANDLE_HARNESS_TURN?: string }
  /** The private home's entries, with each one's kind and, for a link, where it points. */
  home: { name: string; link?: string; file?: boolean }[]
  /** The private home's own files, as Grok would read them. */
  files: { config?: string; managed?: string; sandbox?: string; auth?: string }
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

function homeListing(home: string | undefined): FakeGrokRun["home"] {
  if (!home || !existsSync(home)) return []
  return readdirSync(home).map((name) => {
    const st = lstatSync(join(home, name))
    return st.isSymbolicLink() ? { name, link: readlinkSync(join(home, name)) } : { name, file: st.isFile() }
  })
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined)

async function main(): Promise<void> {
  const o = JSON.parse(process.env.FAKE_GROK ?? "{}") as FakeGrok
  const args = process.argv.slice(2)
  const home = process.env.GROK_HOME
  const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const promptFile = at("--prompt-file")
  const run: FakeGrokRun = {
    argv: args,
    prompt: promptFile ? (read(promptFile) ?? "") : "",
    env: {
      HOME: process.env.FAKE_GROK_HOME,
      GROK_HOME: home,
      GROK_MEMORY: process.env.GROK_MEMORY,
      GROK_WORKFLOWS: process.env.GROK_WORKFLOWS,
      GROK_DISABLE_AUTOUPDATER: process.env.GROK_DISABLE_AUTOUPDATER,
      CANDLE_HARNESS_TURN: process.env.CANDLE_HARNESS_TURN,
    },
    home: homeListing(home),
    files: home
      ? { config: read(join(home, "config.toml")), managed: read(join(home, "managed_config.toml")), sandbox: read(join(home, "sandbox.toml")), auth: read(join(home, "auth.json")) }
      : {},
  }
  if (process.env.FAKE_GROK_LOG) appendFileSync(process.env.FAKE_GROK_LOG, `${JSON.stringify(run)}\n`)
  if (args[0] === "--version") {
    console.log(o.version ?? "grok 1.0.70 (f50904eaee6c)")
    return
  }
  if (args[0] === "models") {
    process.stdout.write(readFileSync(join(FIXTURES, "grok-models.txt"), "utf8"))
    return
  }
  if (!promptFile) {
    console.error(`fake grok: unknown command ${args.join(" ")}`)
    process.exit(2)
  }
  // Real Grok applies the profile before anything else and logs it in its home's sessions folder.
  if (home && (o.sandbox ?? "enforced") !== "none") {
    mkdirSync(join(home, "sessions"), { recursive: true })
    const event = { event_type: "ProfileApplied", profile: at("--sandbox"), workspace: at("--cwd"), platform: "linux/landlock", enforced: (o.sandbox ?? "enforced") === "enforced" }
    writeFileSync(join(home, "sessions", "sandbox-events.jsonl"), `${JSON.stringify(event)}\n`)
  }
  if (o.rotateAuth !== undefined && home) {
    const auth = join(home, "auth.json")
    writeFileSync(`${auth}.new`, o.rotateAuth)
    renameSync(`${auth}.new`, auth)
  }
  for (const line of readFileSync(join(FIXTURES, `${o.fixture ?? "grok"}.jsonl`), "utf8").split("\n").filter(Boolean)) {
    console.log(line)
    if (o.delayMs) await Bun.sleep(o.delayMs)
  }
  if (o.after === "hang") await Bun.sleep(600_000)
  if (o.after === "die") process.kill(process.pid, "SIGKILL")
}

if (import.meta.main) await main()
