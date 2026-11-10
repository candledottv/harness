// harnessEnv, and runLines's process-group handling.
import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { EngineEvent } from "./events"
import { harnessEnv, runLines, tryJson } from "./spawn"

test("keeps only the allowlist: no Candle variables, no tokens, no API keys", () => {
  expect(harnessEnv({ PATH: "/bin", HOME: "/h", CANDLE_VIEW_TOKEN: "x", CANDLE_API_KEY: "k", CANDLE_HARNESS_HOME: "/c", ANTHROPIC_API_KEY: "y", LC_ALL: "C" })).toEqual({
    PATH: "/bin",
    HOME: "/h",
    LC_ALL: "C",
  })
})

test("keeps proxy and CA variables, drops Claude Code's session variables", () => {
  expect(
    harnessEnv({
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy.example:3128",
      no_proxy: "localhost",
      SSL_CERT_FILE: "/etc/ssl/c.crt",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
    }),
  ).toEqual({ PATH: "/bin", HTTPS_PROXY: "http://proxy.example:3128", no_proxy: "localhost", SSL_CERT_FILE: "/etc/ssl/c.crt" })
})

test("Bun's own variables never reach a spawned engine, the MCP shim it starts, or a bot: BUN_OPTIONS can preload code", async () => {
  const parent = { PATH: "/usr/bin:/bin", HOME: "/h", BUN_OPTIONS: "--preload=/tmp/planted.ts", BUN_CONFIG_REGISTRY: "http://x", BUN_JSC_useJIT: "0" }
  expect(harnessEnv(parent)).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h" })
  // A caller that hands runLines an environment of its own (a turn's hooks, a test) still starts the engine without them.
  const turn = runLines("Test", ["sh", "-c", `echo "{\\"done\\":\\"[\${BUN_OPTIONS-none}] [\${BUN_JSC_useJIT-none}]\\"}"`], {
    cwd: tmpdir(),
    env: parent,
    parse: (line) => {
      const m = tryJson(line)
      return m?.done ? [{ type: "done", text: String(m.done) }] : []
    },
  })
  const events: EngineEvent[] = []
  for await (const e of turn.events) events.push(e)
  expect(events).toEqual([{ type: "done", text: "[none] [none]" }])
})

const lines = (script: string) =>
  runLines("Test", ["sh", "-c", script], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
    parse: (line) => {
      const m = tryJson(line)
      return m?.done ? [{ type: "done", text: String(m.done) }] : m?.text ? [{ type: "text", delta: String(m.text) }] : []
    },
  })

async function drain(turn: ReturnType<typeof lines>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const e of turn.events) out.push(e)
  return out
}

test("one done ends the turn, and nothing after it is passed on", async () => {
  expect(await drain(lines(`echo '{"text":"a"}'; echo '{"done":"b"}'; echo '{"text":"late"}'`))).toEqual([
    { type: "text", delta: "a" },
    { type: "done", text: "b" },
  ])
})

test("an exit without a done is one error, with the last of stderr", async () => {
  const events = await drain(lines(`echo '{"text":"a"}'; echo 'boom' >&2; exit 3`))
  expect(events.at(-1)).toEqual({ type: "error", message: expect.stringMatching(/Test ended without finishing the turn \(exit 3\): boom/) })
})

test("cancel ends the whole group, its children included, and says it was cancelled", async () => {
  const turn = lines(`sleep 30 & echo '{"text":"started"}'; wait`)
  const events: EngineEvent[] = []
  for await (const e of turn.events) {
    events.push(e)
    if (e.type === "text") void turn.cancel()
  }
  expect(events.at(-1)).toEqual({ type: "error", message: "Test turn cancelled" })
})
