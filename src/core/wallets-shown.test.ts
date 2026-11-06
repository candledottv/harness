// Which wallets the panes show: the choice, the filter, and keeping it.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isActive, parseShown, readSavedShown, saveShown, shownWallets, unknownNames } from "./wallets-shown"

const dir = mkdtempSync(join(tmpdir(), "chrn-shown-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const embedded = { address: "Emb1111111111111111111111111111111111111111", kind: "embedded" as const, agents: ["agent-a", "agent-b"] }
const ours = { address: "Tee1111111111111111111111111111111111111111", kind: "tee" as const, label: "tee-one", agents: ["agent-a"], active: true }
const stopped = { address: "Tee2222222222222222222222222222222222222222", kind: "tee" as const, label: "old-bot", agents: ["agent-b"], active: false }
const elsewhere = { address: "Tee3333333333333333333333333333333333333333", kind: "tee" as const, label: "Other-Bot", agents: [], active: true }
const all = [embedded, ours, stopped, elsewhere]

test("active: wallets a Candle Harness agent can pay from that Candle hasn't stopped", () => {
  expect(all.map(isActive)).toEqual([true, true, false, false])
  expect(shownWallets(all, "active")).toEqual({ shown: [embedded, ours], hidden: 2 })
  // An embedded wallet no agent here is allowed is inactive too.
  expect(isActive({ ...embedded, agents: [] })).toBe(false)
})

test("all, and a list by embedded, label (any case) or address, in the wallets' own order", () => {
  expect(shownWallets(all, "all")).toEqual({ shown: all, hidden: 0 })
  expect(shownWallets(all, ["other-bot", "embedded"]).shown).toEqual([embedded, elsewhere])
  expect(shownWallets(all, [stopped.address]).shown).toEqual([stopped])
  expect(unknownNames(all, ["tee-one", "nope"])).toEqual(["nope"])
  expect(unknownNames(all, "active")).toEqual([])
})

test("parse: active, all or a short list of names; anything else says what it takes", () => {
  expect(parseShown("active")).toEqual({ ok: true, shown: "active" })
  expect(parseShown([" tee-one ", "tee-one", "embedded"])).toEqual({ ok: true, shown: ["tee-one", "embedded"] })
  for (const bad of ["some", [], [""], [1], Array.from({ length: 21 }, (_, i) => `w${i}`)]) expect(parseShown(bad).ok).toBe(false)
})

test("a group: `group:<name>` shows its wallets, a stopped one still; a group that's gone is named as unknown", () => {
  expect(parseShown("group:bots")).toEqual({ ok: true, shown: "group:bots" })
  for (const bad of ["group:", "group:my bots", `group:${"x".repeat(33)}`]) expect(parseShown(bad).ok).toBe(false)
  const groups = [{ name: "bots", members: [ours.address, elsewhere.address] }]
  expect(shownWallets(all, "group:BOTS", groups)).toEqual({ shown: [ours, elsewhere], hidden: 2 })
  expect(shownWallets([...all, { ...stopped, stopped: true as const }], "group:bots", groups).shown).toContain(ours)
  expect(unknownNames(all, "group:bots", groups)).toEqual([])
  expect(unknownNames(all, "group:snipers", groups)).toEqual(["the group snipers"])
  // Without the groups read, a group shows nothing, and the pane offers "show all".
  expect(shownWallets(all, "group:bots").shown).toEqual([])
})

test("kept privately, and read back; a missing or broken file is nothing", async () => {
  const path = join(dir, "wallets-shown.json")
  expect(readSavedShown(path)).toBeUndefined()
  await saveShown(path, ["tee-one"], Date.parse("2026-10-27T21:00:00Z"))
  expect(readSavedShown(path)).toEqual(["tee-one"])
  expect(statSync(path).mode & 0o777).toBe(0o600)
  await Bun.write(path, "{")
  expect(readSavedShown(path)).toBeUndefined()
})
