// `hide` on perps orders (BE-3996, the client half of BE-3769) and the Candle Harness's own handling of it (BE-3770).
// Candle's CLI, MCP server and SDK are recorded offline from one exact commit (scripts/read-perps-hide-source.ts):
// the three echo helpers on one table of bodies, the SDK's open, close and modify run over an intercepted fetch whose
// build lacks the `hide: true` echo, the shared TP/SL workflow (`runPerpsTpsl`, byte-identical across CLI, MCP and
// SDK) run offline against a stand-in venue and builder, and the clients' hide and docs as source text. The Candle
// Harness's side is read against them: `--hide` goes through on `perps close` and `perps tpsl` (the rows with a card),
// the card says the order is hidden, a refusal for a missing echo is a refusal only where nothing was signed, and a
// candle CLI that predates the flag is told apart from a bug (and logs no `core.bug`). Nothing here reaches Candle, a
// wallet or a venue.
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fixture from "../../test/fixtures/candle-perps-hide-source.json"
import { Redactor } from "../shared/redact"
import { hiddenWords } from "./cards"
import { classify } from "./classify"
import { CliCards, mapCliRow, UploadStage } from "./cli-cards"
import { resolveCall } from "./cli-tool"
import type { Operation } from "./execute"
import { Journal } from "./journal"

type Row = { id: string; scenario: string; args: Record<string, any>; outcome: Record<string, any> }
const rows = fixture.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const ctx = { defaultAgent: "momentum", agents: new Set(["momentum"]) }

test("the recording names the exact staging build, the versions that carry hide, and the files", () => {
  expect(fixture.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "95bad55f61ae7e29a181c9d1c0e8fabaca8e104c",
    versions: { cli: "0.13.47", mcp: "0.10.45", sdk: "0.6.39" },
  })
  expect(fixture.source.files).toContain("packages/cli/src/commands/perps-manage.ts")
  expect(fixture.source.files).toContain("docs/agent-trading.md")
  expect(rows).toHaveLength(36)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["echo", "sdk-run", "tpsl-run", "source-pin", "clients"]))
})

test("nothing in the recording is a wallet address, a key or an account value", () => {
  const text = JSON.stringify(fixture)
  expect(text.match(/0x[0-9a-fA-F]{40}\b/g) ?? []).toEqual([])
  expect(text.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) ?? []).toEqual([])
  expect(text).not.toMatch(/cndl_|sk_live|BEGIN|accountValue|walletAddress/)
})

test("only `hide: true` is an echo in the MCP and the SDK; the CLI also takes the stored name; every other body is refused", () => {
  expect(row("echo-hide-true").outcome).toEqual({ cli: true, mcp: true, sdk: true })
  expect(row("echo-stream-hidden-true").outcome).toEqual({ cli: true, mcp: false, sdk: false })
  for (const id of ["hide-false", "hide-string-true", "hide-one", "no-key", "null", "array", "text"]) expect(row(`echo-${id}`).outcome).toEqual({ cli: false, mcp: false, sdk: false })
})

test("an order that didn't ask for hide is never checked, and the refusal says nothing was signed and the order may be public", () => {
  expect(row("echo-not-asked-checks-nothing").outcome).toEqual({ sdk: "no refusal", cli: "no refusal" })
  expect(row("echo-refusal-words").outcome).toEqual({ cliCode: { code: "HIDE_NOT_CONFIRMED", says: true, warnsNotHidden: true }, mcpSays: true, sdkRetryable: false })
})

test("the SDK refuses a hidden open, close and modify whose build lacks the echo, after the one build request", () => {
  for (const [id, path] of [["open", "/api/v1/agent/perps/open"], ["close", "/api/v1/agent/perps/close"], ["modify", "/api/v1/agent/perps/modify"]] as const) {
    expect(row(`sdk-${id}-without-echo-is-refused`).outcome).toEqual({ refused: { code: "HIDE_NOT_CONFIRMED", status: 502 }, requests: [{ path, sendsHide: true }] })
  }
  expect(row("sdk-open-without-hide-sends-no-hide-key").outcome).toEqual({ bodiesWithAHideKey: 0, requests: 2 })
})

test("the shared TP/SL workflow keeps cancels plain, echoes hide on attach, and never signs an unechoed attach", () => {
  const replaced = row("sdk-tpsl-hidden-replacement-echoed").outcome
  expect(replaced).toEqual({
    complete: true,
    signs: 2,
    builds: [
      { path: "/api/v1/agent/perps/tpsl", operation: "cancel", hasHideKey: false, hide: null },
      { path: "/api/v1/agent/perps/tpsl", operation: "attach", hasHideKey: true, hide: true },
    ],
    steps: [
      { kind: "cancel", status: "confirmed" },
      { kind: "attach", status: "confirmed" },
    ],
    remainingTriggerPx: ["56000"],
  })
  const refused = row("sdk-tpsl-hidden-attach-without-echo-refused").outcome
  expect(refused).toEqual({
    complete: false,
    signs: 1,
    builds: [
      { path: "/api/v1/agent/perps/tpsl", operation: "cancel", hasHideKey: false, hide: null },
      { path: "/api/v1/agent/perps/tpsl", operation: "attach", hasHideKey: true, hide: true },
    ],
    steps: [
      { kind: "cancel", status: "confirmed" },
      { kind: "attach", status: "rejected", detail: "HIDE_NOT_CONFIRMED: the API did not echo hide: true. This step was not signed." },
    ],
    remainingTriggerPx: [],
  })
  const removed = row("sdk-tpsl-remove-only-with-hide-uses-plain-cancel").outcome
  expect(removed).toEqual({
    complete: true,
    signs: 1,
    builds: [{ path: "/api/v1/agent/perps/tpsl", operation: "cancel", hasHideKey: false, hide: null }],
    steps: [{ kind: "cancel", status: "confirmed" }],
    remainingTriggerPx: [],
  })
})

test("every pinned source and docs line is found, and the four orders take hide in all three clients", () => {
  expect(scenario("source-pin").length).toBeGreaterThanOrEqual(17)
  for (const r of scenario("source-pin")) expect(r.outcome.found).toBe(true)
  expect(row("manage-helpers-identical-across-cli-mcp-sdk").outcome.found).toBe(true)
  expect(row("clients-carry-perps-hide").outcome).toEqual({ cliPerpsTakesHide: true, mcpPerpsTakesHide: true, mcpManageTakesHide: true, sdkOpenCloseModifyTakeHide: true, sdkTpslTakesHide: true })
})

test("the Candle Harness passes --hide through on perps close and perps tpsl, to the CLI as the agent gave it", () => {
  for (const [subcommand, args] of [["close", ["BTC", "--pct", "50"]], ["tpsl", ["BTC", "--stop-loss", "50000"]]] as const) {
    const r = resolveCall({ command: "perps", subcommand, args: [...args, "--hide"] }, ctx)
    expect(r.ok).toBe(true)
    expect(r.ok ? r.call.argv : []).toEqual(expect.arrayContaining(["--hide"]))
  }
})

test("an unknown flag is still refused on a perps row, and a value isn't taken as hide's", () => {
  const unknown = resolveCall({ command: "perps", subcommand: "close", args: ["BTC", "--hidden"] }, ctx)
  expect(unknown).toEqual({ ok: false, code: "FLAG_NOT_ALLOWED", message: "candle perps close has no --hidden flag." })
})

test("MCP perps writes are still refused by the Candle Harness, hide or not", () => {
  for (const tool of ["candle_perps_open", "candle_perps_close", "candle_perps_modify", "candle_perps_tpsl"]) for (const mode of ["live", "paper"] as const) for (const args of [{}, { hide: true }]) expect(classify(tool, args, mode)).toMatchObject({ class: "refused" })
})

test("a hidden perps card says the order is hidden, and a TP/SL card says only its attached legs are", () => {
  const close = hiddenWords("close" as never, { params: {}, cliRow: { row: "perps close", argv: ["perps", "close", "BTC", "--hide", "--yes"] } })
  expect(close).toBe("hidden: Candle keeps this order's fills out of its public activity stream; they still count in the agent's own record, and Hyperliquid's own public data still shows them")
  const tpsl = hiddenWords("close" as never, { params: {}, cliRow: { row: "perps tpsl", argv: ["perps", "tpsl", "BTC", "--stop-loss", "5", "--hide"] } })
  expect(tpsl).toContain("the legs it attaches")
  expect(hiddenWords("close" as never, { params: {}, cliRow: { row: "perps close", argv: ["perps", "close", "BTC"] } })).toBeUndefined()
})

test("a close that the CLI refused for a missing echo is a refusal (nothing signed); a TP/SL's is not, since a cancel may have gone first", () => {
  const run = (code: string) => ({ exitCode: 1, timedOut: false, json: { ok: false, code, message: "x" } })
  const close = mapCliRow("perps close", run("HIDE_NOT_CONFIRMED"))
  expect(close.state).toBe("refused")
  expect(close.error).toMatchObject({ code: "HIDE_NOT_CONFIRMED", retryable: false })
  expect(close.error?.message).toContain("signed and sent nothing")
  expect(mapCliRow("perps tpsl", run("HIDE_NOT_CONFIRMED")).state).toBe("unknown")
})

test("a TP/SL plan whose attach step wasn't signed for a missing echo isn't reported as done", () => {
  const body = { operation: "tpsl", complete: false, steps: [{ status: "confirmed" }, { status: "rejected", detail: "HIDE_NOT_CONFIRMED: the API did not echo hide: true. This step was not signed." }] }
  expect(mapCliRow("perps tpsl", { exitCode: 0, timedOut: false, json: body }).state).toBe("unknown")
})

test("a candle CLI older than perps --hide is refused on both close and tpsl, not called a Candle Harness bug, and logs no core.bug", async () => {
  for (const rowName of ["perps close", "perps tpsl"]) {
    const old = mapCliRow(rowName, { exitCode: 2, timedOut: false, json: { ok: false, code: "USAGE", message: "Unknown flag: --hide" } })
    expect(old.state).toBe("refused")
    expect(old.error).toMatchObject({ code: "HIDE_NEEDS_NEWER_CLI", retryable: false })
    expect(old.error?.message).not.toContain("bug in the Candle Harness")
  }
  const other = mapCliRow("perps close", { exitCode: 2, timedOut: false, json: { ok: false, code: "USAGE", message: "Unknown flag: --nope" } })
  expect(other.error?.message).toContain("bug in the Candle Harness")

  const dir = mkdtempSync(join(tmpdir(), "chrn-perps-hide-"))
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => 1_790_000_000_000 })
  try {
    const stage = new UploadStage(join(dir, "uploads"))
    let reply = { exitCode: 2, stdout: "", stderr: "", timedOut: false, json: { ok: false, code: "USAGE", message: "Unknown flag: --hide" } }
    const cards = new CliCards({
      cli: { runExact: async () => reply },
      redactor: new Redactor(),
      journal,
      stage,
      now: () => 1_790_000_000_000,
    })
    const op = { opId: "op_1", mode: "live", agent: "momentum", params: { row: "perps tpsl", agent: "momentum", argv: ["perps", "tpsl", "BTC", "--stop-loss", "50000", "--hide", "--yes"] } } as unknown as Operation
    const oldRun = await cards.execute(op)
    expect(oldRun).toMatchObject({ state: "refused", error: { code: "HIDE_NEEDS_NEWER_CLI" } })
    expect(journal.rows().filter((e) => e.type === "core.bug")).toEqual([])

    reply = { exitCode: 2, stdout: "", stderr: "", timedOut: false, json: { ok: false, code: "USAGE", message: "Unknown flag: --nope" } }
    await cards.execute(op)
    expect(journal.rows().filter((e) => e.type === "core.bug")).toHaveLength(1)
  } finally {
    await journal.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
