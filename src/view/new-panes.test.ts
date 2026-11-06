// A preset's new panes, offered to a layout of yours saved from it.
import { expect, test } from "bun:test"
import { panesOf, RESEARCH } from "./layout"
import { layoutNamed, layoutsText, parseLayouts } from "./layouts-file"
import { newPanes, presetOf, withNewPane } from "./new-panes"

const own = (text: string, name: string) => layoutNamed(parseLayouts(text), name)!

test("the preset a layout was saved from: its record, else its name; none for a preset or another name", () => {
  expect(presetOf(own(`[layouts."My Research"]\nroot = ["row", "token", "agent"]\n`, "My Research"))?.name).toBe("Research")
  expect(presetOf(own(`[layouts."My Cockpit 2"]\nroot = ["row", "token", "agent"]\n`, "My Cockpit 2"))?.name).toBe("Cockpit")
  expect(presetOf(own(`[layouts.Desk]\nfrom = "Research"\nfrom_panes = ["token", "agent"]\nroot = ["row", "token", "agent"]\n`, "Desk"))?.name).toBe("Research")
  expect(presetOf(own(`[layouts.Desk]\nroot = ["row", "token", "agent"]\n`, "Desk"))).toBeUndefined()
  expect(presetOf(RESEARCH)).toBeUndefined()
})

test("new panes: the preset's, less those it had when saved, those on the layout, and those dismissed", () => {
  // Saved before the list pane: offered.
  const old = own(`[layouts.Desk]\nfrom = "Research"\nfrom_panes = ["token", "check", "traders", "token-signals", "mentions", "agent"]\nroot = ["row", "token", "agent"]\n`, "Desk")
  expect(newPanes(old, [])).toEqual(["lists"])
  expect(newPanes(old, ["lists"])).toEqual([])
  // Saved after it, with panes closed on purpose: nothing to offer.
  const later = own(`[layouts.Desk]\nfrom = "Research"\nfrom_panes = ${JSON.stringify(panesOf(RESEARCH.root))}\nroot = ["row", "token", "agent"]\n`, "Desk")
  expect(newPanes(later, [])).toEqual([])
  // No record (saved before layouts recorded it): only the panes the preset gained, never one it always had.
  expect(newPanes(own(`[layouts."My Research"]\nroot = ["row", "token", "agent"]\n`, "My Research"), [])).toEqual(["lists"])
  expect(newPanes(own(`[layouts."My Cockpit 2"]\nroot = ["row", "feed", "token"]\n`, "My Cockpit 2"), [])).toEqual([])
})

test("a new pane goes where the preset has it: after the sibling before it, else before the one after it, else at the end", () => {
  const mine = own(`[layouts."My Research"]\nroot = ["row", ["row", 62, ["column", 55, "token 16", "check 20"], ["column", 45, "traders 34", "token-signals 33", "mentions 33"]], "agent 38"]\n`, "My Research")
  const added = withNewPane(mine, RESEARCH, "lists")
  if ("refused" in added) throw new Error(added.refused)
  expect(panesOf(added.root)).toEqual(["token", "check", "lists", "traders", "token-signals", "mentions", "agent"])
  const after = withNewPane(own(`[layouts.X]\nroot = ["row", ["column", 50, "lists", "mentions"], "agent"]\n`, "X"), RESEARCH, "traders")
  if ("refused" in after) throw new Error(after.refused)
  expect(panesOf(after.root)).toEqual(["lists", "traders", "mentions", "agent"])
  const none = withNewPane(own(`[layouts.X]\nroot = ["row", "token", "agent"]\n`, "X"), RESEARCH, "mentions")
  if ("refused" in none) throw new Error(none.refused)
  expect(panesOf(none.root)).toEqual(["token", "agent", "mentions"])
})

test("layouts.toml keeps from and from_panes as written, and names a wrong one by its line", () => {
  const text = `[layouts.Desk]\ncollapse = 130\nfrom = "Research"\nfrom_panes = ["token", "agent"]\nroot = ["row", "token", "agent"]\n`
  const file = parseLayouts(text)
  expect(file.problems).toEqual([])
  expect(layoutNamed(file, "Desk")!.from).toEqual({ preset: "Research", panes: ["token", "agent"] })
  expect(layoutNamed(parseLayouts(layoutsText(file)), "Desk")!.from).toEqual({ preset: "Research", panes: ["token", "agent"] })
  const bad = parseLayouts(`[layouts.Desk]\nfrom = "Nowhere"\nfrom_panes = ["token"]\nroot = ["row", "token", "agent"]\n`)
  expect(bad.problems[0]).toContain(`from is "Nowhere"`)
  // The layout itself still loads, without the record.
  expect(layoutNamed(bad, "Desk")!.from).toBeUndefined()
})
