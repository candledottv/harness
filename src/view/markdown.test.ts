import { expect, test } from "bun:test"
import { shortAddress } from "./format"
import { inline } from "./markdown"

test("an address in a reply is shown short in every spelling, an EVM address in either case", () => {
  const evm = "0x52908400098527886E0F7030069857D2E4169EE7"
  const runs = inline(`Send to ${evm}, again: ${evm.toLowerCase()}`)
  expect(runs.map((r) => r.text).join("")).toBe(`Send to ${shortAddress(evm)}, again: ${shortAddress(evm.toLowerCase())}`)
})
