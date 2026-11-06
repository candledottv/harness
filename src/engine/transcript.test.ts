import { expect, test } from "bun:test"
import type { JournalRow } from "../core/journal"
import { type Exchange, TRANSCRIPT_CHARS, TRANSCRIPT_EXCHANGES, Transcript, toolSummary } from "./transcript"
import { claudeParser } from "./claude"
import { codexParser } from "./codex"
import type { EngineEvent } from "./events"
import { grokParser } from "./grok"
import { opencodeParser } from "./opencode"
import { piParser } from "./pi"

const exchange = (n: number, reply = `reply ${n}`): Exchange => ({ turnId: `t_${n}`, user: `message ${n}`, reply, tools: [], outcome: "done" })

test("a first message is sent as it is", () => {
  expect(new Transcript().promptFor("hi")).toBe("hi")
})

test("later prompts carry the conversation, oldest first, then the new message", () => {
  const t = new Transcript()
  t.add(exchange(1))
  t.add({ ...exchange(2), tools: ["candle_get_market {} → ok"], outcome: "stopped" })
  const prompt = t.promptFor("and now?")
  expect(prompt.indexOf("message 1")).toBeLessThan(prompt.indexOf("message 2"))
  expect(prompt).toContain("You: reply 2 [turn stopped]\n(tools: candle_get_market {} → ok)")
  expect(prompt).toContain("not instructions")
  expect(prompt.endsWith("The person now says:\nand now?")).toBe(true)
})

test("the budget keeps the last 30 exchanges", () => {
  const t = new Transcript()
  for (let n = 1; n <= 45; n++) t.add(exchange(n))
  const recent = t.recent()
  expect(recent).toHaveLength(TRANSCRIPT_EXCHANGES)
  expect(recent[0]!.turnId).toBe("t_16")
  expect(recent.at(-1)!.turnId).toBe("t_45")
})

test("the budget keeps at most 60k characters, dropping the oldest", () => {
  const t = new Transcript()
  for (let n = 1; n <= 10; n++) t.add(exchange(n, "x".repeat(15_000)))
  const recent = t.recent()
  expect(recent.length).toBe(3)
  expect(recent.at(-1)!.turnId).toBe("t_10")
  expect(t.promptFor("next").length).toBeLessThan(TRANSCRIPT_CHARS + 1_000)
})

test("rebuilt from the journal, one agent's turns only", () => {
  const row = (agent: string, n: number) => ({ seq: n, at: "", account: "a", mode: "live", type: "agent.turn", agent, ...exchange(n) }) as unknown as JournalRow
  const rows = [row("momentum", 1), row("swing", 2), { seq: 3, at: "", account: "a", mode: "live", type: "agent.turn_started", agent: "momentum" } as JournalRow, row("momentum", 4)]
  expect(Transcript.fromJournal(rows, "momentum").all().map((e) => e.turnId)).toEqual(["t_1", "t_4"])
})

test("a tool call in one line: name, input and how it answered", () => {
  expect(toolSummary("mcp__candle__candle_trade", { side: "buy" }, '{"success":false,"error":{"code":"APPROVAL_REQUIRED"}}')).toBe('candle_trade {"side":"buy"} → APPROVAL_REQUIRED')
  expect(toolSummary("WebSearch", { query: "q" }, "results")).toBe('WebSearch {"query":"q"} → ok')
  expect(toolSummary("Read", { file_path: "/x" }, undefined)).toBe('Read {"file_path":"/x"} → no answer')
  // A call the harness marked an error, such as a gate's refusal, says so; a code still wins.
  expect(toolSummary("read", { path: "/etc/passwd" }, "error: outside the research folder", true)).toBe('read {"path":"/etc/passwd"} → failed: error: outside the research folder')
  expect(toolSummary("candle_trade", {}, '{"error":{"code":"LIMIT_PER_TRADE"}}', true)).toBe("candle_trade {} → LIMIT_PER_TRADE")
  expect(toolSummary("x", { long: "y".repeat(500) }, "ok").length).toBe(160)
  // A long input is what's cut, never how it answered (a trade's long reason once cut its answer off).
  const long = toolSummary("candle_trade", { side: "sell", reason: "z".repeat(500) }, '{"error":{"code":"APPROVAL_REQUIRED"}}')
  expect(long.length).toBe(160)
  expect(long.endsWith("… → APPROVAL_REQUIRED")).toBe(true)
})

test("every engine's parser marks a call the harness says failed, so Activity never says ok for a refusal", () => {
  const last = (events: EngineEvent[]) => events.find((e) => e.type === "tool_result")
  const claude = claudeParser()
  claude(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/etc/passwd" } }] } }))
  expect(last(claude(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "outside", is_error: true }] } })))).toMatchObject({ failed: true })

  const grok = grokParser()
  grok(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "g1", name: "read_file", input: { path: "/x" } }] } }))
  expect(last(grok(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "g1", content: "denied", is_error: true }] } })))).toMatchObject({ failed: true })

  const codex = codexParser()
  const item = { id: "c1", type: "command_execution", command: "rm x", status: "declined" }
  expect(last(codex(JSON.stringify({ type: "item.completed", item })))).toMatchObject({ failed: true })
  expect(last(codex(JSON.stringify({ type: "item.completed", item: { ...item, id: "c2", status: "completed", exit_code: 0 } })))).not.toHaveProperty("failed")

  expect(last(piParser()(JSON.stringify({ type: "tool_execution_end", toolCallId: "p1", toolName: "read", result: { content: [{ type: "text", text: "refused" }] }, isError: true })))).toMatchObject({ failed: true, output: "error: refused" })

  const part = (status: string) => JSON.stringify({ type: "message.part.updated", properties: { part: { type: "tool", tool: "read", callID: "o1", state: { status, input: {}, error: "outside", output: "x" } } } })
  expect(last(opencodeParser()(part("error")))).toMatchObject({ failed: true })
  expect(last(opencodeParser()(part("completed")))).not.toHaveProperty("failed")
})
