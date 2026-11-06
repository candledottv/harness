import { expect, test } from "bun:test"
import { readAnswer, ViewAsks } from "./view-asks"

test("the view used last is asked; with none used yet, the newest attached; a slow view is said in words", async () => {
  let listening = ["a", "b"]
  const sent: { data: unknown; clientId: string }[] = []
  let t = 0
  const asks = new ViewAsks({ listening: () => listening, publish: (data, clientId) => sent.push({ data, clientId }), now: () => ++t, timeoutMs: 30 })
  expect(asks.target()).toBe("b")
  asks.used("a")
  expect(asks.target()).toBe("a")
  asks.used("b")
  expect(asks.target()).toBe("b")
  // The view used last went: the other one is asked.
  listening = ["a"]
  asks.detached("b")
  expect(asks.target()).toBe("a")
  const slow = await asks.ask("momentum", { action: "read" })
  expect(slow).toMatchObject({ ok: false, code: "VIEW_SLOW" })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ clientId: "a", data: { agent: "momentum", args: { action: "read" } } })
  // A late answer is taken by nothing.
  expect(asks.answer("a", (sent[0]!.data as { id: string }).id, { ok: true, text: "late" })).toBe(false)
  listening = []
  expect(await asks.ask("momentum", { action: "read" })).toMatchObject({ ok: false, code: "NO_VIEW" })
})

test("an answer reaches the agent as plain text, cut to size; a refusal keeps a code only of the Candle Harness's shape", () => {
  expect(readAnswer({ ok: true, text: "Done \u001b[31mred\u001b[0m.", words: "switched\nto Cockpit" })).toEqual({ ok: true, text: "Done [31mred[0m.", words: "switched to Cockpit" })
  expect(readAnswer({ ok: false, code: "UNKNOWN_TAB", text: "No tab." })).toEqual({ ok: false, code: "UNKNOWN_TAB", message: "No tab." })
  expect(readAnswer({ ok: false, code: "not a code!", text: "" })).toEqual({ ok: false, code: "VIEW_REFUSED", message: "The view couldn't make that change." })
  expect(readAnswer(null)).toMatchObject({ ok: false })
  expect((readAnswer({ ok: true, text: "x".repeat(20_000) }) as { text: string }).text.length).toBe(12 * 1024)
})
