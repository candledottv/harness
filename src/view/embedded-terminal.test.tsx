// The embedded terminal: drawn in the theme's own default colours, and wiped when another process takes it, so the
// last harness's screen never shows under the next one's title.
import { afterEach, expect, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { EmbeddedTerminal } from "./embedded-terminal"
import type { PaneProcess } from "./pane-process"

const hex = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")

class Proc implements PaneProcess {
  pid = 1
  private listeners: ((c: Uint8Array) => void)[] = []
  exited = new Promise<number>(() => {})
  write() {}
  resize() {}
  signal() {}
  close() {}
  onData(l: (c: Uint8Array) => void) {
    this.listeners.push(l)
  }
  emit(text: string) {
    for (const l of this.listeners) l(new TextEncoder().encode(text))
  }
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
})

test("the terminal's default text and background are the theme's, not white on black", async () => {
  const proc = new Proc()
  const s = await testRender(<EmbeddedTerminal proc={proc} width={10} height={2} focused={false} colours={{ fg: "#dde2ea", bg: "#111419" }} />, { width: 10, height: 2 })
  dispose = () => s.renderer.destroy()
  await act(async () => proc.emit("hi"))
  await s.renderOnce()
  const span = s.captureSpans().lines[0]!.spans[0]!
  expect([hex(span.fg), hex(span.bg)]).toEqual(["dde2ea", "111419"])
})

test("another process in the same terminal starts on a clear screen, the last one's text gone", async () => {
  const first = new Proc()
  const second = new Proc()
  let swap: (p: Proc) => void = () => {}
  function Holder() {
    const [proc, setProc] = useState<Proc>(first)
    swap = setProc
    return <EmbeddedTerminal proc={proc} width={20} height={2} focused={false} colours={{ fg: "#dde2ea", bg: "#111419" }} />
  }
  const s = await testRender(<Holder />, { width: 20, height: 2 })
  dispose = () => s.renderer.destroy()
  await act(async () => first.emit("old harness"))
  await s.renderOnce()
  expect(s.captureCharFrame()).toContain("old harness")
  await act(async () => swap(second))
  await s.renderOnce()
  expect(s.captureCharFrame()).not.toContain("old harness")
  await act(async () => second.emit("new"))
  await s.renderOnce()
  expect(s.captureCharFrame()).toContain("new")
  // The theme's defaults hold after the reset.
  expect(hex(s.captureSpans().lines[0]!.spans[0]!.bg)).toBe("111419")
})
