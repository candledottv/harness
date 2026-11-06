// A stand-in for the `opencode` binary, so `bun test` needs no OpenCode installed. It
// answers `--version`, `models` and `auth list`, and `serve` serves the slice of OpenCode's HTTP API the
// engine uses: the event stream, sessions, prompt_async, abort and permission replies, behind the same
// basic-auth password. As real OpenCode does, it loads the plugins our config names when a session is
// made, so the engine's gate really runs and really writes its marker. A prompt replays a recorded stream
// (test/fixtures/engine/opencode*.jsonl). What it was run with, and each request, is logged for the tests.
//
// `fakeOpenCode(o)` writes an `opencode` wrapper that sets the behaviour and runs this file, since an
// engine turn's environment is cut down to harnessEnv's allowlist and can't carry it.
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const FIXTURES = join(import.meta.dir, "fixtures/engine")

export interface FakeOpenCode {
  /** The fixture a prompt replays, by name: "opencode", "opencode-signedout", "opencode-cancel". */
  fixture?: string
  /** Extra lines replayed after the fixture (each a /event payload). */
  extra?: unknown[]
  /** What `--version` prints. */
  version?: string
  /** Milliseconds between replayed lines. */
  delayMs?: number
  /** After replaying, keep the stream open (a turn that never ends on its own) or die. */
  after?: "end" | "hang" | "die"
  /** Whether the plugins named in our config load when a session is made, as real OpenCode's do. */
  plugins?: "load" | "skip"
  /** prompt_async's answer, when not 204. */
  promptStatus?: number
  /** What `auth list` prints: the recorded one (an OpenAI sign-in) by default. */
  authList?: string
}

export interface FakeOpenCodeRun {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  /** OPENCODE_CONFIG_CONTENT, parsed. */
  config?: any
  /** Each request the server took: method, path and body. */
  requests: { method: string; path: string; body?: any }[]
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** A folder holding `opencode`, which runs this fake with `o`, and the log it writes (one JSON line per run, then one per request). */
export function fakeOpenCode(o: FakeOpenCode = {}): { bin: string; dir: string; runs(): FakeOpenCodeRun[] } {
  const dir = mkdtempSync(join(tmpdir(), "chrn-fake-opencode-"))
  const log = join(dir, "runs.jsonl")
  const bin = join(dir, "opencode")
  // Bun writes into HOME, so the fake runs with its own and logs the one it was given.
  writeFileSync(bin, `#!/bin/sh\nFAKE_OPENCODE=${shq(JSON.stringify(o))} FAKE_OPENCODE_LOG=${shq(log)} FAKE_OPENCODE_HOME="$HOME" HOME=${shq(dir)} exec ${shq(process.execPath)} ${shq(import.meta.path)} "$@"\n`)
  chmodSync(bin, 0o755)
  const runs = () => {
    if (!existsSync(log)) return []
    const out: FakeOpenCodeRun[] = []
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line)
      if (e.kind === "run") out.push({ ...e.run, requests: [] })
      else out.find((r) => r.env.PID === e.pid)?.requests.push(e.request)
    }
    return out
  }
  return { bin, dir, runs }
}

const ENV_LOGGED = [
  "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_SERVER_PASSWORD", "CANDLE_HARNESS_RESEARCH_DIR", "CANDLE_GATE_MARKER", "CANDLE_HARNESS_TURN", "OPENCODE_PURE",
]

async function main(): Promise<void> {
  const o = JSON.parse(process.env.FAKE_OPENCODE ?? "{}") as FakeOpenCode
  const args = process.argv.slice(2)
  const log = (e: unknown) => process.env.FAKE_OPENCODE_LOG && appendFileSync(process.env.FAKE_OPENCODE_LOG, `${JSON.stringify(e)}\n`)
  const env: Record<string, string | undefined> = { PID: String(process.pid) }
  for (const k of ENV_LOGGED) env[k] = k === "HOME" ? process.env.FAKE_OPENCODE_HOME : process.env[k]
  const config = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : undefined
  log({ kind: "run", run: { argv: args, cwd: process.cwd(), env, config } })
  if (args[0] === "--version") return void console.log(o.version ?? "1.19.5")
  if (args[0] === "models") return void process.stdout.write(readFileSync(join(FIXTURES, "opencode-models.txt"), "utf8"))
  if (args[0] === "auth" && args[1] === "list") return void process.stdout.write(o.authList ?? readFileSync(join(FIXTURES, "opencode-auth-list.txt"), "utf8"))
  if (args[0] !== "serve") {
    console.error(`fake opencode: unknown command ${args.join(" ")}`)
    process.exit(2)
  }

  const password = process.env.OPENCODE_SERVER_PASSWORD ?? ""
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const enc = new TextEncoder()
  const send = (payload: unknown) => {
    for (const c of streams) c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
  }
  let aborted = false
  const replay = async (sessionID: string) => {
    const lines = readFileSync(join(FIXTURES, `${o.fixture ?? "opencode"}.jsonl`), "utf8").split("\n").filter(Boolean)
    for (const line of [...lines.map((l) => JSON.parse(l)), ...(o.extra ?? [])]) {
      if (aborted) return
      send(JSON.parse(JSON.stringify(line).replaceAll("ses_fixture", sessionID)))
      if (o.delayMs) await Bun.sleep(o.delayMs)
    }
    if (o.after === "die") {
      await Bun.sleep(200) // let what was sent reach the engine first
      process.kill(process.pid, "SIGKILL")
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" && req.headers.get("content-type")?.includes("json") ? await req.json().catch(() => undefined) : undefined
      log({ kind: "request", pid: String(process.pid), request: { method: req.method, path: url.pathname, ...(body === undefined ? {} : { body }) } })
      if (req.headers.get("authorization") !== `Basic ${btoa(`opencode:${password}`)}`) return new Response("unauthorized", { status: 401 })
      if (url.pathname === "/event") {
        let ctl: ReadableStreamDefaultController<Uint8Array>
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              ctl = c
              streams.add(c)
              c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`))
            },
            cancel() {
              streams.delete(ctl)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      if (url.pathname === "/session" && req.method === "POST") {
        // Real OpenCode loads the config's plugins as the session's instance starts.
        if ((o.plugins ?? "load") === "load") {
          for (const p of config?.plugin ?? []) {
            const mod = await import(fileURLToPath(p))
            for (const f of Object.values(mod)) if (typeof f === "function") await (f as () => Promise<unknown>)()
          }
        }
        return Response.json({ id: "ses_fake1" })
      }
      const m = /^\/session\/([^/]+)(?:\/(prompt_async|abort))?$/.exec(url.pathname)
      if (m && m[2] === "prompt_async") {
        if (o.promptStatus) return new Response("model not found", { status: o.promptStatus })
        void replay(m[1]!)
        return new Response(null, { status: 204 })
      }
      if (m && m[2] === "abort") {
        aborted = true
        send({ type: "session.error", properties: { sessionID: m[1], error: { name: "MessageAbortedError", data: { message: "Aborted" } } } })
        return Response.json(true)
      }
      if (m && req.method === "DELETE") return Response.json(true)
      if (/^\/permission\/[^/]+\/reply$/.test(url.pathname)) return Response.json(true)
      return new Response("not found", { status: 404 })
    },
  })
  console.log(`opencode server listening on http://127.0.0.1:${server.port}`)
  await new Promise(() => {})
}

if (import.meta.main) await main()
