// Linked panes on screen: a click on a token row picks it, highlighted
// while its pane has focus; the token pane's pin chip pins and unpins it; a pinned token pane shows its own
// token while the link moves on. Drawn with the scenes' realistic data.
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { CLOCK, drawScene, MINT } from "../../test/frame-scenes"
import { C } from "./theme"
import { memoryStore } from "./layouts-store"
import { SETTINGS_CHIP } from "./tabs"

process.env.TZ = "UTC"

type Drawn = Awaited<ReturnType<typeof drawScene>>
let drawn: Drawn | undefined
afterEach(async () => {
  const d = drawn
  drawn = undefined
  if (d) await act(async () => d.setup.renderer.destroy())
})

const frame = () => drawn!.setup.captureCharFrame()
const settle = async (fn: () => void | Promise<void>) => {
  await act(async () => {
    await fn()
  })
  await drawn!.setup.renderOnce()
}
const find = (text: string): { x: number; y: number } => {
  const rows = frame().split("\n")
  const y = rows.findIndex((r) => r.includes(text))
  if (y < 0) throw new Error(`${text} isn't on screen:\n${frame()}`)
  return { x: rows[y]!.indexOf(text), y }
}
const click = (text: string, dx = 1) => settle(() => {
  const at = find(text)
  return drawn!.setup.mockMouse.click(at.x + dx, at.y)
})
const push = (topic: string, data: unknown) => settle(() => drawn!.session.push(topic, data))
const requests = (method: string) => drawn!.session.requests.filter((r) => r.method === method).map((r) => r.params)
/** The background of the cell at a row and column. */
const bgAt = (y: number, x: number): string => {
  const line = drawn!.setup.captureSpans().lines[y]!
  let col = 0
  for (const span of line.spans) {
    if (x < col + span.width) return `#${[span.bg.r, span.bg.g, span.bg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
    col += span.width
  }
  return ""
}

const FENNEL = "Trend4".padEnd(43, "1")

test("a click on a Feed row picks its token at once, highlighted while Feed has focus", async () => {
  drawn = await drawScene("followed", 160, 45, "cockpit")
  await click("FENNE")
  expect(requests("view.link")).toEqual([{ mint: FENNEL, from: "feed, by a click" }])
  const at = find("FENNE")
  expect(bgAt(at.y, at.x)).toBe(C.sel)
  // Focus elsewhere: the highlight isn't drawn.
  await click("╭─ Signals", 3)
  expect(bgAt(at.y, at.x)).not.toBe(C.sel)
})

test("the pin chip pins the token pane on its tab; pinned, it shows its own token and says so, while the link moves on", async () => {
  drawn = await drawScene("followed", 140, 40)
  expect(frame()).toContain("Token · JUPF · follows the agent")
  await click(" pin ", 2)
  expect(requests("view.pin")).toEqual([{ at: "Trade", pane: "token" }])
  // The core pins it, and the link moves to another token: the pane stays on JUPF.
  const base = { followed: null, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null, trending: null }
  await push("market", {
    ...base,
    followed: { mint: FENNEL, chain: "solana", symbol: "FENNE", since: CLOCK, by: "you" },
    market: { symbol: "FENNE", priceUsd: 0.00084, marketCap: 840_000, liquidityUsd: 90_000, at: CLOCK - 2_000 },
    pinned: [{ mint: MINT, chain: "solana", symbol: "JUPF", since: CLOCK - 60_000, market: { name: "Jupiter Fake", symbol: "JUPF", priceUsd: 0.4249, marketCap: 1_284_000_000, liquidityUsd: 18_400_000, at: CLOCK - 3_000 }, check: null, samples: [], history: [], historyRead: null, change1h: null }],
  })
  await push("views", { link: { mint: FENNEL, chain: "solana", symbol: "FENNE", since: CLOCK, by: "you" }, pins: [{ at: "Trade", mint: MINT, chain: "solana", symbol: "JUPF" }] })
  expect(frame()).toContain("Token · JUPF · pinned")
  expect(frame()).toContain("Jupiter Fake")
  expect(frame()).toContain(" unpin ")
  await click(" unpin ", 2)
  expect(requests("view.unpin")).toEqual([{ at: "Trade", pane: "token" }])
  await push("views", { link: { mint: FENNEL, chain: "solana", symbol: "FENNE", since: CLOCK, by: "you" }, pins: [] })
  expect(frame()).toContain("Token · FENNE · you picked")
})

test("another token pane: the layout menu offers only the next one, opens it pinned on the token shown, its chip is its own, and closed its pin goes", async () => {
  drawn = await drawScene("followed", 160, 45, "trade", memoryStore())
  await settle(() => drawn!.setup.mockMouse.click(find(SETTINGS_CHIP).x + 1, find(SETTINGS_CHIP).y))
  await click("this tab's panes")
  // One row for the next token pane, saying what it does; never token:3 before token:2.
  expect(frame()).toContain("another token pane, pinned on the token shown")
  expect(frame()).not.toContain("token:3")
  await click("token:2", 0)
  // It opens pinned on the token the first one shows, beside it.
  expect(requests("view.pin")).toEqual([{ at: "Trade", pane: "token:2" }])
  await push("views", { link: { mint: MINT, chain: "solana", symbol: "JUPF", since: CLOCK, by: "agent" }, pins: [{ at: "Trade", pane: "token:2", mint: MINT, chain: "solana", symbol: "JUPF" }], signals: [], popped: [] })
  expect(frame().match(/Token · JUPF/g)?.length).toBe(2)
  // Its unpin chip names it: the first's pin chip is the first's.
  await click(" unpin ", 2)
  expect(requests("view.unpin")).toEqual([{ at: "Trade", pane: "token:2" }])
  await push("views", { link: { mint: MINT, chain: "solana", symbol: "JUPF", since: CLOCK, by: "agent" }, pins: [], signals: [], popped: [] })
  // Opened beside the focused pane (the agent), token:2 is the left of the two.
  await click(" pin ", 2)
  expect(requests("view.pin").at(-1)).toEqual({ at: "Trade", pane: "token:2" })
  await push("views", { link: { mint: MINT, chain: "solana", symbol: "JUPF", since: CLOCK, by: "agent" }, pins: [{ at: "Trade", pane: "token:2", mint: MINT, chain: "solana", symbol: "JUPF" }], signals: [], popped: [] })
  // Now token:3 is the one offered.
  await settle(() => drawn!.setup.mockMouse.click(find(SETTINGS_CHIP).x + 1, find(SETTINGS_CHIP).y))
  await click("this tab's panes")
  expect(frame()).toContain("token:3")
  // Esc is told from a longer key only after a pause.
  await settle(async () => {
    drawn!.setup.mockInput.pressEscape()
    await Bun.sleep(30)
  })
  expect(frame()).not.toContain("layout · Trade")
  // Closed, its pin goes, so it holds none of the three. Focused by a click on its title.
  await click("╭─ Token", 3)
  await settle(() => drawn!.setup.mockMouse.click(find(SETTINGS_CHIP).x + 1, find(SETTINGS_CHIP).y))
  await click("this tab's panes")
  expect(frame()).toContain("The focused pane, token:2")
  await click("close token:2")
  expect(requests("view.unpin").at(-1)).toEqual({ at: "Trade", pane: "token:2" })
  expect(frame().match(/Token · JUPF/g)?.length).toBe(1)
})
