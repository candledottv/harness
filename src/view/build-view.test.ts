import { expect, test } from "bun:test"
import type { BotsTopic } from "../core/bots"
import { folderLines, testLines } from "./build-view"

const text = (lines: { segs: { text: string }[] }[]) => lines.map((l) => l.segs.map((s) => s.text).join("")).join("\n")
const folder = { path: "/tmp/bots", shown: "~/bots", subs: ["momentum"] }
const NOW = Date.parse("2026-11-09T15:00:00Z")

test("a bot folder whose card waits says so, not that nothing was proposed", () => {
  const topic = { codeCards: [{ name: "momentum", folder: "/tmp/bots/momentum", cardId: "c1", change: false }] } as unknown as BotsTopic
  const out = text(folderLines({ folder, topic, daemons: [], width: 40, now: NOW }))
  expect(out).toContain("its card waits")
  expect(out).not.toContain("not proposed yet")
  const change = { codeCards: [{ name: "momentum", folder: "/tmp/bots/momentum", cardId: "c2", change: true }] } as unknown as BotsTopic
  expect(text(folderLines({ folder, topic: change, daemons: [], width: 40, now: NOW }))).toContain("its change card waits")
})

test("with no test running, the test box says how the last test ended and what it left open", () => {
  const topic = { testsEnded: [{ name: "test:momentum", agent: "agent-a", said: "The test ended. Its paper position stays open in agent-a's paper book.", at: "2026-11-09T14:58:00Z", open: 1 }] } as unknown as BotsTopic
  const out = text(testLines({ topic, width: 60, now: NOW })).replace(/\n(?=\S)/g, " ")
  expect(out).toContain("Its paper position stays open in agent-a's paper book.")
  expect(out).toContain("No test running.")
})
