// A core with no agents: what onboarding runs on. The prompt pane's tickets, the
// engines and addAgent work; Candle's reads wait for the first agent, nothing trades, and `status` says setup.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { storeNewAgentKey } from "../setup/key-add"
import type { Card } from "./cards"
import { METHOD_ROLES } from "./server"

afterAll(() => cleanupHomes())
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})

async function setupCore() {
  const cliDir = mkdtempSync(join(tmpdir(), "chrn-setup-cli-"))
  writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ vault: { missing: true }, keysCreate: { prefix: "Agentaaa" }, authKeyPrefix: "Ownerkey" }))
  const t = await startTestCore(
    { env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } },
    {
      config: { agents: {}, activeAgent: "" },
      // A fresh machine: no config.toml and no keys. The first key's store writes the config.
      before: (p) => {
        rmSync(p.keyFile("momentum"))
        rmSync(p.keyFile("swing"))
        rmSync(p.configFile)
      },
    },
  )
  cores.push(t)
  return { t, view: await t.view() }
}

describe("a core with no agents", () => {
  test("it says it's in setup, reads nothing from Candle, and nothing trades or takes a message", async () => {
    const { t, view } = await setupCore()
    const status = (await view.request("core.status", {})).result as Record<string, unknown>
    expect(status).toMatchObject({ setup: true, agents: [], activeAgent: "" })
    expect(t.core.pool.agents()).toEqual([])
    const trade = await view.request("cards.propose", { tool: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "buy", amountUsd: "1" }, typed: true })
    expect(trade.error?.data?.code).toBe("NO_AGENT_YET")
    expect((await view.request("agent.send", { text: "hello" })).error?.data?.code).toBe("NO_AGENT_YET")
    // Onboarding and forgetting the vault are the person's: no harness or pane may call them.
    for (const m of ["onboarding.get", "onboarding.set", "vault.forget"]) expect(METHOD_ROLES[m]).toEqual({ view: "yes", harness: "no" })
    // The engines still answer: the picker and onboarding's test message need no agent.
    const models = await view.request("engine.models", { engine: "codex" })
    expect(models.result).toMatchObject({ engine: "codex" })
  }, 30_000)

  test("the first agent's key is made in the pane with no restart: it's the active agent, setup ends, and Candle starts for it", async () => {
    const { t, view } = await setupCore()
    const r = (await view.request("cli.run", { argv: ["keys", "create", "--label", "agent-a"] })).result as { ticket: string; ticketId: string; card: Card }
    expect(r.card).toMatchObject({ kind: "owner", agent: "" })
    await view.request("pane.spawned", { ticketId: r.ticketId, pid: process.pid })
    const { client: pane } = await t.hello(r.ticket)
    expect((await pane.request("pane.redeem")).result).toMatchObject({ newAgent: "agent-a", identity: "owner" })
    expect(await storeNewAgentKey(t.p, "agent-a", prefixedKey("Agentaaa"))).toEqual({ ok: true, prefix: "Agentaaa" })
    const reported = (await pane.request("pane.report", { stage: "command", exit: 0, captured: { prefix: "Agentaaa", agent: "agent-a", stored: true } })).result as { words: string }
    expect(reported.words).toBe("made agent-a (key Agentaaa…): it's in the Agents list now.")
    await until(() => t.core.pool.agents().includes("agent-a"))
    const status = (await view.request("core.status", {})).result as Record<string, unknown>
    expect(status.setup).toBeUndefined()
    expect(status).toMatchObject({ activeAgent: "agent-a" })
    // The setup card's rows carry no agent: no agent existed when it was made.
    const rows = t.core.journal.rows().filter((x) => x.cardId === r.card.cardId || x.opId === r.card.opId)
    expect(rows.length).toBeGreaterThan(2)
    for (const row of rows) expect(row.agent).toBeUndefined()
    expect(t.core.journal.rows().find((x) => x.type === "agent.added")).toMatchObject({ agent: "agent-a" })
  }, 30_000)
})
