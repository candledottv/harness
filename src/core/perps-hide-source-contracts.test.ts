// `hide` on perps orders (BE-3996, the client half of BE-3769) and the Candle Harness's own handling of it (BE-3770).
// Candle's CLI, MCP server and SDK are recorded offline from one exact commit (scripts/read-perps-hide-source.ts):
// the three echo helpers on one table of bodies, the SDK's open, close and modify run over an intercepted fetch whose
// build lacks the `hide: true` echo, and the clients' hide as source text. The Candle Harness's side is read against
// them: `--hide` goes through on `perps close` and `perps tpsl` (the rows with a card), the card says the order is
// hidden, a refusal for a missing echo is a refusal only where nothing was signed, and a candle CLI that predates the
// flag is told apart from a bug. Nothing here reaches Candle, a wallet or a venue.
import { expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-perps-hide-source.json"
import { hiddenWords } from "./cards"
import { classify } from "./classify"
import { mapCliRow } from "./cli-cards"
import { resolveCall } from "./cli-tool"

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
  expect(fixture.source).toMatchObject({ repo: "candledottv/candle-monorepo", commit: "bdf8548b9d6c3844b014f25ae1725cbae6f8b544", versions: { cli: "0.13.39", mcp: "0.10.42", sdk: "0.6.32" } })
  expect(fixture.source.files).toContain("packages/cli/src/commands/perps-manage.ts")
  expect(rows).toHaveLength(30)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["echo", "sdk-run", "source-pin", "clients"]))
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

test("every pinned source line is found, and the four orders take hide in all three clients", () => {
  expect(scenario("source-pin").length).toBeGreaterThanOrEqual(13)
  for (const r of scenario("source-pin")) expect(r.outcome.found).toBe(true)
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

test("a candle CLI older than perps --hide is said to be old, not a Candle Harness bug, and nothing was sent", () => {
  const old = mapCliRow("perps close", { exitCode: 2, timedOut: false, json: { ok: false, code: "USAGE", message: "Unknown flag: --hide" } })
  expect(old.state).toBe("refused")
  expect(old.error).toMatchObject({ code: "HIDE_NEEDS_NEWER_CLI", retryable: false })
  expect(old.error?.message).not.toContain("bug in the Candle Harness")
  const other = mapCliRow("perps close", { exitCode: 2, timedOut: false, json: { ok: false, code: "USAGE", message: "Unknown flag: --nope" } })
  expect(other.error?.message).toContain("bug in the Candle Harness")
})
