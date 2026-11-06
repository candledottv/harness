// The full repaint after a resize leans on a private flag of OpenTUI's renderer (repaint.ts): this fails
// if the pinned OpenTUI drops it, rather than the repaint quietly doing nothing.
import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { forceRepaint } from "./repaint"

test("OpenTUI's renderer still has the full-repaint flag the view sets after a resize", async () => {
  const { renderer } = await createTestRenderer({ width: 40, height: 10 })
  try {
    expect(forceRepaint(renderer)).toBe(true)
    expect((renderer as unknown as { forceFullRepaintRequested: boolean }).forceFullRepaintRequested).toBe(true)
  } finally {
    renderer.destroy()
  }
})

test("a renderer without it is left alone", () => {
  let asked = 0
  expect(forceRepaint({ requestRender: () => asked++ })).toBe(false)
  expect(asked).toBe(0)
})
