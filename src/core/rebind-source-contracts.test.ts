// `candle tee rebind` onto a key with a signer (BE-4315, harness sibling BE-4316), as the published CLI runs it: one owner
// approval on the fixed API, and the CLI-local stops REBIND_CONFIRM_SPENT (an older API used the approval before it asked
// for the wallets' owner signatures) and REBIND_OWNERS_CHANGED. Recorded offline from the exact published release commit
// (scripts/read-rebind-source.ts): CLI 0.13.47, MCP 0.10.45 and SDK 0.6.39.
import { expect, test } from "bun:test"
import rebind from "../../test/fixtures/candle-rebind-source.json"

type Row = { id: string; scenario: string; evidence?: string; args: Record<string, any>; outcome: Record<string, any> }
const rows = rebind.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}

test("the recording names the exact published release build and the files the rebind lives in", () => {
  expect(rebind.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "5d7a861a83bcc5c4f2c3dace9897c325b3525e43",
    versions: { cli: "0.13.47", mcp: "0.10.45", sdk: "0.6.39" },
  })
  expect(rebind.source.files).toContain("packages/cli/src/commands/tee-rebind.ts")
  expect(rows).toHaveLength(5)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["fixed-api", "older-api", "owners-changed", "source"]))
})

test("nothing in the recording is a key, a token or a real address", () => {
  const text = JSON.stringify(rebind)
  for (const secret of ["BEGIN", "cndl_", "Addr", "pw-"]) expect(text).not.toContain(secret)
})

test("a key-signer rebind on the fixed API takes one approval: unsigned 409, signed 403, approved resend 200", () => {
  const r = row("fixed-api-one-approval")
  expect(r.outcome).toMatchObject({
    exitCode: 0,
    requests: ["preview", "unsigned", "signed", "signed"],
    confirmsIssued: 1,
    confirmsRedeemed: 1,
    approvalPrompts: 1,
    signedWallets: 1,
    wallet: { boundTo: "target-key", owner: "target-signer" },
  })
})

test("on an older API the approval is spent first: the CLI stops with REBIND_CONFIRM_SPENT, mints no second confirm and changes nothing", () => {
  const r = row("older-api-confirm-spent")
  expect(r.outcome).toMatchObject({
    exitCode: 1,
    requests: ["preview", "unsigned", "unsigned"],
    confirmsIssued: 1,
    confirmsRedeemed: 1,
    approvalPrompts: 1,
    wallet: { boundTo: "original-key", owner: "legacy-signer" },
  })
  expect(r.outcome.says).toEqual([
    "Approved, but the server then asked for the wallets' owner signatures",
    "nothing changed and nothing more was sent",
    "Do not run it again yet",
    "Once the API carries the BE-4315 fix",
  ])
})

test("--json carries REBIND_CONFIRM_SPENT and the advice to wait, and the run that follows does not repeat now", () => {
  expect(row("older-api-confirm-spent-json").outcome).toMatchObject({
    exitCode: 1,
    code: "REBIND_CONFIRM_SPENT",
    suggestionStartsWith: "Do not run it again yet",
    wallet: { boundTo: "original-key", owner: "legacy-signer" },
  })
})

test("on the fixed API an owner that changes while the approval is pending stops with REBIND_OWNERS_CHANGED before the approval is used", () => {
  expect(row("fixed-api-owners-changed").outcome).toMatchObject({
    exitCode: 1,
    requests: ["preview", "unsigned", "unsigned"],
    confirmsIssued: 1,
    confirmsRedeemed: 0,
    approvalPrompts: 1,
    wallet: { boundTo: "original-key" },
  })
})

test("both stops are CLI-local codes pinned from the CLI's source", () => {
  expect(row("source-cli-local-codes").outcome.codes).toEqual([
    { name: "REBIND_CONFIRM_SPENT", code: "REBIND_CONFIRM_SPENT" },
    { name: "REBIND_OWNERS_CHANGED", code: "REBIND_OWNERS_CHANGED" },
  ])
})
