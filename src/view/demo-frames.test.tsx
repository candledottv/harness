// The docs' moving picture, as kept frames: a short story played through the real App, each
// step kept in test/fixtures/frames/ as demo-NN, and drawn by scripts/doc-images.ts as one animated SVG. You ask
// about a token, the token pane follows it, the agent's answer streams in and ends on a card, the card is
// approved and fills, and the Cockpit shows. A change to any of those screens changes these frames, and with
// UPDATE_FRAMES=1 the picture follows.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import { card, CLOCK, drawScene, followed, REPLY } from "../../test/frame-scenes"
import { DEMO_SIZE, DEMO_STEPS } from "../../scripts/doc-images"

process.env.TZ = "UTC"
const DIR = join(import.meta.dir, "../../test/fixtures/frames")
const UPDATE = process.env.UPDATE_FRAMES === "1"

type Setup = Awaited<ReturnType<typeof drawScene>>["setup"]
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

function serialise(s: Setup): string {
  const hex = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")
  const runs = s
    .captureSpans()
    .lines.map((l, y) => `${y}: ${l.spans.map((sp) => `${hex(sp.fg)}/${hex(sp.bg)}${sp.attributes ? `+${sp.attributes}` : ""}×${sp.width}`).join(" ")}`)
    .join("\n")
  return `${s.captureCharFrame()}\n--- colours ---\n${runs}\n`
}

const QUESTION = "how's JUPF looking?"
/** The reply as it streams: three pieces, each ending on a line. */
const PIECES = (() => {
  const lines = REPLY.split("\n")
  return [lines.slice(0, 3).join("\n"), `\n${lines.slice(3, 8).join("\n")}`, `\n${lines.slice(8).join("\n")}`]
})()

test("the moving picture's story, step by step", async () => {
  const [width, height] = DEMO_SIZE
  const drawn = await drawScene("trending", width, height)
  setup = drawn.setup
  const s = drawn.setup
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => drawn.session.push(topic, data, snapshot))
    await s.renderOnce()
  }
  const frames: string[] = [serialise(s)]
  const keep = () => frames.push(serialise(s))

  // The question, typed a few letters at a time.
  for (let at = 4; at < QUESTION.length + 4; at += 4) {
    await act(async () => s.mockInput.typeText(QUESTION.slice(at - 4, at)))
    await s.renderOnce()
    keep()
  }
  // Sent: the turn starts, and the token pane follows what the agent reads.
  await act(async () => s.mockInput.pressEnter())
  await s.renderOnce()
  await push("agent", { agent: "agent-a", turnId: "t2", type: "started", user: QUESTION })
  keep()
  await push("market", followed())
  keep()
  for (const delta of PIECES) {
    await push("agent", { agent: "agent-a", turnId: "t2", type: "text", delta })
    keep()
  }
  // The answer ends on a card.
  await push("agent", { agent: "agent-a", turnId: "t2", type: "ended", user: QUESTION, reply: REPLY, outcome: "done" })
  await push("cards", card)
  keep()
  // Approved with one press, then filled.
  await push("cards", { ...card, state: "approved", approvedHow: "enter", operation: { state: "running" } })
  await push("operations", [{ opId: "op-c1", cardId: "c1", agent: "agent-a", state: "running", kind: "trade", startedAt: CLOCK - 1_000 }], true)
  keep()
  await push("cards", { ...card, state: "approved", approvedHow: "enter", operation: { state: "succeeded" } })
  await push("operations", [{ opId: "op-c1", cardId: "c1", agent: "agent-a", state: "succeeded", kind: "trade", startedAt: CLOCK - 5_300, settledAt: CLOCK - 1_000 }], true)
  await push("activity", { kind: "line", entry: { seq: 31, at: new Date(CLOCK - 1_000).toISOString(), agent: "agent-a", text: "filled BUY 0.1 SOL → JUPF", tone: "good" } })
  keep()
  // The Cockpit, by a click on its tab; the pointer then moves off it, so no hover colour is kept.
  const tabs = s.captureCharFrame().split("\n")[1]!
  await act(async () => s.mockMouse.click(tabs.indexOf("2 Cockpit") + 2, 1))
  await s.renderOnce()
  await act(async () => s.mockMouse.moveTo(0, height - 1))
  await s.renderOnce()
  keep()

  expect(frames.length).toBe(DEMO_STEPS.length)
  frames.forEach((got, i) => {
    const file = join(DIR, `${DEMO_STEPS[i]!.frame}.txt`)
    if (UPDATE || !existsSync(file)) {
      if (!UPDATE) throw new Error(`No frame kept for ${DEMO_STEPS[i]!.frame}: run with UPDATE_FRAMES=1 to keep it.`)
      mkdirSync(DIR, { recursive: true })
      writeFileSync(file, got)
    } else expect(got).toBe(readFileSync(file, "utf8"))
  })
})
