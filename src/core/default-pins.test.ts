// Where each agent's default wallet was last found: kept by line and address, 0600,
// and nothing pinned from a file that's missing, unreadable or holds something that isn't an address.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DefaultPins, pinnedAddress, readDefaultPins } from "./default-pins"

const A = "TeeOne11111111111111111111111111111111111111"
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const fileIn = () => {
  const d = mkdtempSync(join(tmpdir(), "chrn-pins-"))
  dirs.push(d)
  return join(d, "default-wallets.json")
}

test("a pin holds only for the line it was found for, and survives a restart", () => {
  const file = fileIn()
  const pins = new DefaultPins(file)
  expect(pins.get("momentum", "bot")).toBeUndefined()
  pins.set("momentum", "bot", A)
  expect(pins.get("momentum", "bot")).toBe(A)
  expect(pins.get("momentum", "spare")).toBeUndefined()
  expect(pins.get("momentum", undefined)).toBeUndefined()
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(new DefaultPins(file).get("momentum", "bot")).toBe(A)
  expect(pinnedAddress(readDefaultPins(file), "momentum", "bot")).toBe(A)
})

test("a missing, broken or odd file pins nothing, and nothing that isn't an address is kept", () => {
  const file = fileIn()
  expect(readDefaultPins(file)).toEqual({})
  writeFileSync(file, "{not json")
  expect(readDefaultPins(file)).toEqual({})
  writeFileSync(file, JSON.stringify({ pins: { momentum: { setting: "bot", address: "../../etc" }, swing: { setting: 1, address: A } } }))
  expect(readDefaultPins(file)).toEqual({})
  const pins = new DefaultPins(file)
  pins.set("momentum", "bot", "not an address")
  expect(JSON.parse(readFileSync(file, "utf8")).pins.momentum).toEqual({ setting: "bot", address: "../../etc" })
})
