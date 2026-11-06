// The palette across a resize that collapses the layout under it: it stays whole, on top.
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { drawScene } from "../../test/frame-scenes"

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

test("the palette stays whole and on top when a resize collapses the Cockpit under it", async () => {
  drawn = await drawScene("trending", 138, 39, "cockpit")
  await settle(() => drawn!.setup.mockInput.pressKey("k", { ctrl: true }))
  expect(frame()).toContain("palette")
  await settle(() => drawn!.setup.resize(82, 25))
  await settle(async () => await Bun.sleep(5))
  const rows = frame().split("\n")
  // The palette's box runs the whole width, its right edge unbroken, and the collapsed Token pane isn't over it.
  const top = rows.findIndex((r) => r.startsWith("╭─ palette"))
  expect(top).toBeGreaterThanOrEqual(0)
  expect(rows[top]!.trimEnd().endsWith("╮")).toBe(true)
  const inside = rows.slice(top + 1, rows.findIndex((r, i) => i > top && r.startsWith("╰")))
  expect(inside.length).toBeGreaterThan(5)
  for (const r of inside) expect(r.trimEnd().endsWith("│")).toBe(true)
  expect(frame()).not.toContain("─ Token ─")
})
