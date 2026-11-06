// Candle's per-asset caps from the status read: `limits.keyLimits`, null for none.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AgentStatusBook, parseExecutionStatus } from "./agent-status"
import type { ToolOutcome } from "./candle-mcp"

const recorded = (name: string) => (JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/candle-recorded", name), "utf8")) as { outcome: { result: unknown } }).outcome.result

const withLimits = (limits: Record<string, unknown>) => ({ wallets: { wallets: { solana: { address: "WalletFake111111111111111111111111111111111" } } }, limits })

describe("Candle's per-asset caps", () => {
  test("the recorded keys have none: no caps, never an empty cap", () => {
    for (const name of ["cli-agent-a-candle_execution_status.json", "tee/cli-agent-b-candle_execution_status.json"]) {
      const result = recorded(name) as { limits: { keyLimits: unknown } }
      expect(result.limits.keyLimits).toBeNull()
      const status = parseExecutionStatus(result, 0)!
      expect(status.wallets.solana).toBeDefined()
      expect(status.assetCaps).toBeUndefined()
    }
  })

  test("the docs' shape is read, lowercased, and kept as raw strings", () => {
    const status = parseExecutionStatus(withLimits({ keyLimits: [{ asset: "SOL", maxPerTxRaw: "2000000000" }, { asset: "usdc", maxPerTxRaw: 5000000 }], txLimit: null }), 0)!
    expect(status.assetCaps).toEqual([
      { asset: "sol", maxPerTxRaw: "2000000000" },
      { asset: "usdc", maxPerTxRaw: "5000000" },
    ])
  })

  test("an entry that isn't a whole raw amount for a named asset is left out", () => {
    const status = parseExecutionStatus(withLimits({ keyLimits: [{ asset: "sol", maxPerTxRaw: "1.5" }, { asset: "sol", maxPerTxRaw: -1 }, { maxPerTxRaw: "1" }, { asset: "x y", maxPerTxRaw: "1" }, null, { asset: "cndl", maxPerTxRaw: "0" }] }), 0)!
    // A cap of zero is a real cap (docs.candle.tv/developers/agent-trading: "a raw cap of zero, still binds").
    expect(status.assetCaps).toEqual([{ asset: "cndl", maxPerTxRaw: "0" }])
  })
})

describe("a read that couldn't read the key's limits", () => {
  const wallets = { wallets: { solana: { address: "WalletFake111111111111111111111111111111111" } } }
  const good = { success: true, wallets, limits: { success: true, txLimit: { usdMicros: 50_000_000, reset: "never" }, keyLimits: [{ asset: "sol", maxPerTxRaw: "1000000000" }] } }
  const partial = { success: false, unreadable: ["limits"], wallets }

  test("is marked unread, never read as a key with no cap", () => {
    const status = parseExecutionStatus(partial, 0)!
    expect(status.limitsUnread).toBe(true)
    expect(status.keyLimit).toBeUndefined()
    expect(parseExecutionStatus({ wallets, limits: { success: false, txLimit: null } }, 0)!.limitsUnread).toBe(true)
    expect(parseExecutionStatus(good, 0)!.limitsUnread).toBeUndefined()
  })

  test("keeps the caps the last read had", async () => {
    const answers: ToolOutcome[] = [
      { kind: "ok", result: good },
      { kind: "error", code: "PARTIAL", retryable: true, body: partial },
    ]
    const book = new AgentStatusBook({ pool: { for: () => ({ call: async () => answers.shift()! }) }, now: () => 0 })
    await book.refresh("momentum")
    const after = (await book.refresh("momentum"))!
    expect(after.keyLimit).toEqual({ usd: 50, reset: "never" })
    expect(after.assetCaps).toEqual([{ asset: "sol", maxPerTxRaw: "1000000000" }])
    expect(after.limitsUnread).toBeUndefined()
    expect(after.unreadable).toEqual(["limits"])
  })
})
