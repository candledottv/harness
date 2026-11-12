// The doctor's perps line (spec docs/specs/perps-writes.md §5, Phase 0): the key's perps:write, an EVM TEE wallet promoted
// onto it, and its signer on this machine.
import { describe, expect, test } from "bun:test"
import type { Config } from "../config"
import { perpsChecks } from "./doctor"

const cfg = (writes: boolean) => ({ perps: { writes } }) as unknown as Config
const wallet = { id: "tee_evm", address: "0x00000000000000000000000000000000000e7ee1", label: "hl-one", chain: "hood", active: true }
const read = (opts: { tee?: unknown[]; signers?: Record<string, unknown> } = {}) => ({ status: {}, portfolio: undefined, tee: opts.tee ?? [wallet], ...(opts.signers ? { signers: opts.signers } : {}) }) as never
const owned = (scopes: string[]) => new Map([["cnd_aaa", { keyPrefix: "cnd_aaa", scopes }]]) as never
const prefixes = new Map([["momentum", "cnd_aaa"]])
const run = (writes: boolean, o: ReturnType<typeof owned> | undefined, r: ReturnType<typeof read>) => perpsChecks(cfg(writes), new Map([["momentum", r]]), prefixes, o)

describe("doctor: perps writes", () => {
  test("says nothing for an agent whose key has no perps:write while the setting is off", () => {
    expect(run(false, owned(["account:read", "swap:write"]), read())).toEqual([])
  })
  test("ready: perps:write, an active EVM TEE wallet, its signer here", () => {
    const [c, ...rest] = run(true, owned(["account:read", "perps:write"]), read({ signers: { tee_evm: "stored" } }))
    expect(rest).toEqual([])
    expect(c).toMatchObject({ state: "ok" })
    expect(c!.text).toContain("perps:write")
    expect(c!.text).toContain("hl-one")
  })
  test("a key with perps:write is checked even while the setting is off, and the line says it's off", () => {
    const [c] = run(false, owned(["perps:write"]), read({ signers: { tee_evm: "stored" } }))
    expect(c!.text).toContain("perps.writes is off")
  })
  test("warns, each by itself: no perps:write, no EVM TEE wallet, no signer here", () => {
    expect(run(true, owned(["account:read"]), read({ signers: { tee_evm: "stored" } })).some((c) => c.state === "warn" && c.text.includes("lacks perps:write"))).toBe(true)
    expect(run(true, owned(["perps:write"]), read({ tee: [] })).some((c) => c.state === "warn" && c.text.includes("no active EVM TEE wallet"))).toBe(true)
    expect(run(true, owned(["perps:write"]), read({ signers: { tee_evm: "missing" } })).some((c) => c.state === "warn" && c.text.includes("no signer on this machine"))).toBe(true)
  })
  test("skips, not warns, when the key list or the signers weren't read", () => {
    expect(run(true, undefined, read({ signers: { tee_evm: "stored" } })).some((c) => c.state === "skip")).toBe(true)
    expect(run(true, owned(["perps:write"]), read()).some((c) => c.state === "skip" && c.text.includes("signer"))).toBe(true)
  })
  test("a key that holds perps:withdraw is named", () => {
    expect(run(true, owned(["perps:write", "perps:withdraw"]), read({ signers: { tee_evm: "stored" } })).some((c) => c.state === "warn" && c.text.includes("perps:withdraw"))).toBe(true)
  })
})
