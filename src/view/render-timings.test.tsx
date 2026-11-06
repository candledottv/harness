// The view's memory: React's development build records User Timing entries for every
// component it renders, and Bun keeps them, so a view run from source clears them.
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { drawScene, status } from "../../test/frame-scenes"
import { dropRenderTimings } from "./run"

let stop = () => {}
afterEach(() => stop())

test("a re-render of the App records timings, and the view clears them", async () => {
  const { setup, session } = await drawScene("followed", 140, 40)
  performance.clearMeasures()
  performance.clearMarks()
  for (let i = 0; i < 20; i++) {
    await act(async () => session.push("status", { ...status } as never, true))
    await setup.renderOnce()
  }
  expect(performance.getEntries().length).toBeGreaterThan(20)
  stop = dropRenderTimings(20)
  await Bun.sleep(60)
  expect(performance.getEntries().length).toBe(0)
  setup.renderer.destroy()
})
