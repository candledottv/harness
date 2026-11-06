// Copying from a pane: a drag over a wrapped bullet copied its first and last line only.
// OpenTUI keeps, within a row, only the pieces inside the drag's columns, so a row's text must start at its left
// edge and reach its right one.
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { C } from "../theme"
import { type Line, Lines, line } from "./lines"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  act(() => setup?.renderer.destroy())
  setup = undefined
})

const indent = (text: string, fg: string = C.ink): Line => ({ segs: [{ text: "  ", fg }, { text, fg }] })
const REPLY: Line[] = [
  { segs: [{ text: "• ", fg: C.dim }, { text: "Every Hacc read needs Pro: the tape,", fg: C.ink }] },
  indent("wallets worth watching, and the strategy lab,"),
  { segs: [{ text: "  ", fg: C.ink }, { text: "final stretch", fg: C.hi }, { text: " and per-wallet results.", fg: C.dim }] },
  indent("Pro opens them."),
  line("Short."),
  line("The last sentence is here, whole."),
]

async function drawn(lines: Line[], width = 60) {
  // biome-ignore lint: test wrapper
  setup = await testRender(
    <box flexDirection="column" width={width} height={lines.length}>
      <Lines lines={lines} width={width} />
    </box>,
    { width, height: lines.length + 2 },
  )
  await act(async () => {
    await setup!.renderOnce()
  })
}

async function drag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
  await act(async () => {
    await setup!.mockMouse.drag(x1, y1, x2, y2)
    await setup!.renderOnce()
  })
  return setup!.renderer.getSelection()?.getSelectedText() ?? ""
}

test("a drag down the left edge copies every row between, the indented and coloured ones included", async () => {
  await drawn(REPLY)
  const text = await drag(2, 0, 3, 5)
  expect(text.split("\n")).toEqual([
    "Every Hacc read needs Pro: the tape,",
    "  wallets worth watching, and the strategy lab,",
    "  final stretch and per-wallet results.",
    "  Pro opens them.",
    "Short.",
    "The ",
  ])
})

test("a drag that starts right of a short row's end still copies that row", async () => {
  await drawn(REPLY)
  const text = await drag(30, 3, 10, 5)
  expect(text).toContain("Short.")
  expect(text).toBe("Short.\nThe last se")
})
