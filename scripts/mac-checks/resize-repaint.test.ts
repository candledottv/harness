// The cmux resize's steering: which side of the split the Candle Harness sits on decides which way narrows it.
import { expect, test } from "bun:test"
import { steer } from "./resize-repaint"

test("a step that widens the Candle Harness turns the split the other way, once, and the run narrows from there", () => {
  // The Candle Harness on the right of the split: -R moves the split right, which narrows it.
  expect(steer(120, 115, "R", false, 40)).toEqual({ direction: "R", turned: false })
  // On the left: -R widens it, so the next step goes -L.
  const turned = steer(120, 125, "R", false, 40)
  expect(turned).toMatchObject({ direction: "L", turned: true })
  expect(turned.note).toBe("-R widened the Candle Harness (120 to 125 columns), so the split moves -L from here")
  expect(steer(125, 120, "L", true, 40)).toEqual({ direction: "L", turned: true })
})

test("the run ends where the Candle Harness stops narrowing, or at --to", () => {
  expect(steer(60, 60, "L", true, 40).stop).toBe("the Candle Harness stopped narrowing at 60 columns")
  expect(steer(60, 65, "L", true, 40).stop).toBe("the Candle Harness stopped narrowing at 65 columns")
  expect(steer(45, 40, "L", true, 40).stop).toBe("the Candle Harness is at 40 columns, --to 40")
})

test("a simulated split, the Candle Harness on the left: every step after the first narrows it, down to --to", () => {
  let width = 120
  let direction: "L" | "R" = "R"
  let turned = false
  const widths: number[] = []
  for (let n = 0; n < 30; n++) {
    const was = width
    width += direction === "R" ? 5 : -5
    widths.push(width)
    const next = steer(was, width, direction, turned, 40)
    if (next.stop) break
    ;({ direction, turned } = next)
  }
  expect(widths[0]).toBe(125)
  expect(widths.at(-1)).toBe(40)
  expect(widths.slice(1).every((w, i) => w < (i === 0 ? 125 : widths[i]!))).toBe(true)
})
