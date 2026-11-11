// A Hood TEE wallet for an agent: the next step the chip types, from no vault to a promote; what follows a finished
// step; funding it, ETH first; and the Solana chip, which counts only Solana vault keys.
import { expect, test } from "bun:test"
import { vaultKeysOn } from "./destinations"
import { freshTeeStep, hoodFundSteps, hoodNewKeyOf, hoodWalletStep, teeLabelFor, walletLabelFor } from "./owner-rows"

const EVM_KEY = "0x00000000000000000000000000000000000c01d1"
const HOOD_TEE = "0x00000000000000000000000000000000000b0B01"

test("the chip's next step: a vault first, then an EVM vault key, then the promote from the one there is", () => {
  expect(hoodWalletStep("agent-a", { prefix: "Abcdefgh", vault: false, evmKeys: [] })).toEqual({ label: "add a Hood wallet", line: "candle vault init" })
  expect(hoodWalletStep("agent-a", { prefix: "Abcdefgh", vault: true, evmKeys: [] })).toEqual({ label: "add a Hood wallet", line: "candle vault new-key --chain evm --label agent-a-hood-key" })
  expect(hoodWalletStep("agent-a", { prefix: "Abcdefgh", vault: true, evmKeys: ["cold-evm"] })).toEqual({
    label: "add a Hood wallet",
    line: "candle vault promote --to-key Abcdefgh --label agent-a-hood --from cold-evm",
  })
  // Several: the person names the one, typed last.
  expect(hoodWalletStep("agent-a", { prefix: "Abcdefgh", vault: true, evmKeys: ["cold-evm", EVM_KEY] }).line).toBe("candle vault promote --to-key Abcdefgh --label agent-a-hood --from ")
  // A name already taken gets the next number, as the Solana label does.
  expect(hoodWalletStep("agent-a", { prefix: "Abcdefgh", vault: true, evmKeys: ["cold-evm"], taken: ["Agent-A-Hood"] }).line).toContain("--label agent-a-hood-2 ")
  expect(hoodWalletStep("agent-a", { prefix: "Abcdefgh", vault: true, evmKeys: [], taken: ["agent-a-hood-key"] }).line).toContain("--label agent-a-hood-key-2")
})

test("the labels: the Solana TEE wallet's as before, and the same rule for any other ending", () => {
  expect(teeLabelFor("agent-a", ["agent-a-tee"])).toBe("agent-a-tee-2")
  expect(walletLabelFor("agent-a", "hood", [])).toBe("agent-a-hood")
  expect(walletLabelFor("agent-a", "hood", ["AGENT-A-HOOD", "agent-a-hood-2"])).toBe("agent-a-hood-3")
})

test("a finished new EVM vault key named for an agent leads to its promote; any other new key leads nowhere", () => {
  const agents = new Map([
    ["agent-a", "Abcdefgh"],
    ["agent-b", "Bcdefghi"],
  ])
  expect(hoodNewKeyOf(["vault", "new-key", "--chain", "evm", "--label", "agent-a-hood-key"], agents)).toEqual({ agent: "agent-a", key: "agent-a-hood-key" })
  expect(hoodNewKeyOf(["vault", "new-key", "--chain", "evm", "--label", "agent-b-hood-key-2"], agents)).toEqual({ agent: "agent-b", key: "agent-b-hood-key-2" })
  // Not for an agent, not EVM, not a new key, or several at once: nothing follows.
  expect(hoodNewKeyOf(["vault", "new-key", "--chain", "evm", "--label", "cold"], agents)).toBeUndefined()
  expect(hoodNewKeyOf(["vault", "new-key", "--chain", "solana", "--label", "agent-a-hood-key"], agents)).toBeUndefined()
  expect(hoodNewKeyOf(["vault", "new-key", "--chain", "evm", "--label", "agent-a-hood-key", "--count", "2"], agents)).toBeUndefined()
  expect(hoodNewKeyOf(["vault", "promote", "--label", "agent-a-hood-key"], agents)).toBeUndefined()
})

test("vault keys by chain: an EVM key never counts for the Solana chip, which fills in its key when there's one Solana key", () => {
  const list = [
    { address: "ColdVau1t1111111111111111111111111111111111", label: "cold", kind: "vault-key" as const },
    { address: EVM_KEY, label: "cold-evm", kind: "vault-key" as const },
    { address: "TeeOne11111111111111111111111111111111111111", label: "bot-1", kind: "tee" as const },
  ]
  expect(vaultKeysOn(list, "solana").map((d) => d.label)).toEqual(["cold"])
  expect(vaultKeysOn(list, "evm").map((d) => d.label)).toEqual(["cold-evm"])
})

test("a fresh Hood TEE wallet's funding, ETH first: a bridge from the key's Solana TEE wallet, the vault key's fund line, or its address to send ETH to", () => {
  const steps = hoodFundSteps("agent-a", { address: HOOD_TEE, solanaTee: "agent-a-tee" })
  expect(steps).toEqual([
    // The bridge's amount goes where the cursor waits, after "bridge ".
    { label: "bridge ETH", line: `bridge  sol to eth from agent-a-tee into ${HOOD_TEE} as agent-a`, cursor: 7 },
    { label: "fund from vault key", line: `candle vault fund ${HOOD_TEE} --asset ETH --amount ` },
    { label: "⧉ address", copy: HOOD_TEE },
  ])
  // With no Solana TEE wallet on the key, no bridge lands in it: the vault key, or a send from elsewhere.
  expect(hoodFundSteps("agent-a", { address: HOOD_TEE }).map((s) => s.label)).toEqual(["fund from vault key", "⧉ address"])
  // Not found yet: the fund line asks for the address.
  expect(hoodFundSteps("agent-a", {})[0]).toEqual({ label: "fund from vault key", line: "candle vault fund <its address> --asset ETH --amount " })
})

test("the Solana fund step follows the wallet's chain: ETH for a Hood wallet, SOL otherwise", () => {
  expect(freshTeeStep(2, "agent-a", { prefix: "Abcdefgh", address: "TeeOne11111111111111111111111111111111111111" }).line).toContain("--asset SOL")
  expect(freshTeeStep(2, "agent-a", { prefix: "Abcdefgh", address: HOOD_TEE }).line).toContain("--asset ETH")
})
