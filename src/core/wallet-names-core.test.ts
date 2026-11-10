// Wallet names through a running core: the Candle Harness's own names written at once, Candle's and the
// vault's renamed in the pane, a batch as one --pairs-from run, `from` by any name, a clashing Candle label taken
// by address only, a rename while a card waits, names across a restart, and the agent's undo.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import type { Card } from "./cards"
import type { PaneResult } from "./pane-plan"
import { pairsFile } from "./wallet-names"
import { candleConfigDir } from "./candle-mcp"

afterAll(() => cleanupHomes())

const TEE = "TeeFake111111111111111111111111111111111111"
const teeN = (i: number) => `Tee${String(i).padStart(2, "0")}${"1".repeat(39)}`

describe("wallet names through a running core", () => {
  const cores: TestCore[] = []
  const cliDirs: string[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
    for (const d of cliDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  async function setup(teeWallets: { id: string; address: string; label?: string; boundKeyPrefix: string }[] = [{ id: "teeA", address: TEE, label: "tee-one", boundKeyPrefix: "Momentum" }], before?: (p: TestCore["p"]) => void) {
    const cliDir = mkdtempSync(join(tmpdir(), "chrn-names-cli-"))
    cliDirs.push(cliDir)
    writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ vault: { passphrase: "pw" }, authKeyPrefix: "Ownerkey", tee: { wallets: teeWallets } }))
    const t = await startTestCore(
      { env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } },
      { keys: { momentum: prefixedKey("Momentum") }, candle: { momentum: { teeWallets } }, config: { mode: "live" }, ...(before ? { before } : {}) },
    )
    cores.push(t)
    const view = await t.view()
    const { client: harness } = await t.harness(view)
    const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(((await harness.request("tools.call", { name, args })).result as { content: { text: string }[] }).content[0]!.text)
    await until(() => t.core.wallets.teeOnKey("Momentum").length === teeWallets.length && t.core.wallets.payable("momentum").embedded !== undefined)
    const embedded = t.core.wallets.payable("momentum").embedded!.address
    return { t, view, harness, tool, embedded }
  }
  async function openPane(t: TestCore, view: TestClient, opened: { ticket: string; ticketId: string }) {
    await view.request("pane.spawned", { ticketId: opened.ticketId, pid: process.pid })
    const { client: pane } = await t.hello(opened.ticket)
    const redeemed = (await pane.request("pane.redeem")).result as { steps: { stage: string; argv: string[] }[] }
    return { pane, redeemed }
  }
  const names = (t: TestCore) => t.core.wallets.view().names ?? []

  test("the embedded wallet named at once: written to wallets.toml, named everywhere, and `from` takes it", async () => {
    const s = await setup()
    const r = (await s.view.request("wallets.name", { wallet: "embedded", name: "main" })).result as { said: string; changeId: string }
    expect(r.said).toContain("→ main")
    expect(readFileSync(s.t.p.walletsFile, "utf8")).toContain(`"${s.embedded}" = "main"`)
    expect(names(s.t).find((e) => e.address === s.embedded)).toMatchObject({ name: "main", owner: "harness", kind: "embedded" })
    for (const word of ["main", "MAIN", "embedded", s.embedded]) expect(s.t.core.wallets.payer("momentum", word)).toMatchObject({ ok: true, kind: "embedded" })
    // A TEE wallet by its Candle label, any case, and by address: what pays is always the address.
    for (const word of ["tee-one", "TEE-ONE", TEE]) expect(s.t.core.wallets.payer("momentum", word)).toMatchObject({ ok: true, kind: "tee", address: TEE, label: "tee-one" })
    expect(s.t.core.journal.rows().filter((row) => row.type === "wallets.named")).toHaveLength(1)
  }, 30_000)

  test("in paper mode the agent may name the embedded wallet by its own name: it's still the key's paper book", async () => {
    const s = await setup()
    await s.view.request("wallets.name", { wallet: "embedded", name: "main" })
    expect((await s.view.request("mode.set", { mode: "paper" })).error).toBeUndefined()
    const paper = await s.tool("candle_trade", { side: "buy", mint: "MoonFake11111111111111111111111111111111111", amount: "0.01", wallet: "main" })
    expect(paper.error?.code).not.toBe("NO_PAPER_TEE")
    expect((await s.tool("candle_trade", { side: "buy", mint: "MoonFake11111111111111111111111111111111111", amount: "0.01", wallet: "tee-one" })).error.code).toBe("NO_PAPER_TEE")
  }, 30_000)

  const FAKE_EVM_WALLET = "0x00000000000000000000000000000000000Fa4e1"
  test("in paper mode the EVM embedded address is the embedded wallet too, for a Hood token's paper trade", async () => {
    const s = await setup()
    expect((await s.view.request("mode.set", { mode: "paper" })).error).toBeUndefined()
    const hoodToken = "0x" + "b2".repeat(20)
    const paper = await s.tool("candle_trade", { side: "buy", mint: hoodToken, amount: "0.01", wallet: FAKE_EVM_WALLET })
    expect(paper.error?.code).not.toBe("NO_PAPER_TEE")
  }, 30_000)

  test("a name the Candle Harness's rules refuse says why, and nothing is written", async () => {
    const s = await setup()
    for (const [name, why] of [["tee-one", "already names"], ["embedded", "embedded wallet"], ["momentum", "agent's name"], [" main", "space"], [TEE, "address"]] as const) {
      const r = await s.view.request("wallets.name", { wallet: "embedded", name })
      expect(`${name}: ${r.error?.data?.code}`).toBe(`${name}: NAME_REFUSED`)
      expect(r.error?.message).toContain(why)
    }
    expect(existsSync(s.t.p.walletsFile)).toBe(false)
    expect((await s.view.request("wallets.name", { wallet: "nobody", name: "x" })).error?.data?.code).toBe("UNKNOWN_WALLET")
  }, 30_000)

  test("a TEE wallet's name is Candle's: from the agent a card for the pane, typed the pane at once; when it finishes the portfolio is read again", async () => {
    const s = await setup()
    const answer = await s.tool("harness_name_wallets", { names: [{ wallet: "tee-one", name: "hot" }] })
    expect(answer.success).toBe(true)
    expect(answer.cards[0].error.code).toBe("APPROVAL_REQUIRED")
    const card = s.t.core.cards.get(answer.cards[0].cardId)! as Card
    expect(card).toMatchObject({ kind: "owner", route: "pane", row: "tee rename" })
    expect(existsSync(s.t.p.walletsFile)).toBe(false)

    const typed = (await s.view.request("wallets.name", { wallet: TEE, name: "hot" })).result as { said: string; panes: { ticket: string; ticketId: string; card: { opId: string } }[] }
    expect(typed.said).toContain("renamed on Candle in the pane")
    const { pane, redeemed } = await openPane(s.t, s.view, typed.panes[0]!)
    expect(redeemed.steps.at(-1)!.argv.slice(0, 4)).toEqual(["tee", "rename", TEE, "hot"])
    const before = s.t.core.wallets.payable("momentum").readAt
    const reported = (await pane.request("pane.report", { stage: "command", exit: 0 })).result as { words: string }
    expect(reported.words).toContain("is now hot")
    expect(s.t.core.wallets.payable("momentum").readAt).toBeGreaterThanOrEqual(before!)
    const told = (s.t.core.operations.get(typed.panes[0]!.card.opId)!.result as { pane: PaneResult }).pane
    expect(told.outcome).toBe("finished")
  }, 30_000)

  test("a default config.toml names by label still pays after a rename, and the rename's outcome names the line to change", async () => {
    const teeWallets = [{ id: "teeA", address: TEE, label: "tee-one", boundKeyPrefix: "Momentum" }]
    const cliDir = mkdtempSync(join(tmpdir(), "chrn-names-cli-"))
    cliDirs.push(cliDir)
    writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ vault: { passphrase: "pw" }, authKeyPrefix: "Ownerkey", tee: { wallets: teeWallets } }))
    const t = await startTestCore(
      { env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } },
      {
        keys: { momentum: prefixedKey("Momentum") },
        candle: { momentum: { teeWallets } },
        config: { mode: "live", agents: { momentum: { name: "momentum", limits: { perTradeUsd: 10, perDayUsd: 50 }, wallet: "tee-one" } } },
      },
    )
    cores.push(t)
    const view = await t.view()
    await until(() => t.core.wallets.teeOnKey("Momentum").length === 1)
    // Found by its line once the names are read, and kept by address from then on, with no call of the test's.
    await until(() => existsSync(t.p.defaultPins))
    expect(JSON.parse(readFileSync(t.p.defaultPins, "utf8")).pins.momentum).toEqual({ setting: "tee-one", address: TEE })
    expect(t.core.wallets.payer("momentum")).toMatchObject({ ok: true, kind: "tee", address: TEE })

    const typed = (await view.request("wallets.name", { wallet: "tee-one", name: "hot" })).result as { panes: { ticket: string; ticketId: string }[] }
    const { pane } = await openPane(t, view, typed.panes[0]!)
    // Candle renames it while the pane runs: the fake's label moves, as the real CLI's rename moves Candle's.
    const script = join(candleConfigDir(t.p.stateDir, "momentum"), "fake-candle.json")
    writeFileSync(script, JSON.stringify({ teeWallets: [{ ...teeWallets[0]!, label: "hot" }] }))
    const reported = (await pane.request("pane.report", { stage: "command", exit: 0 })).result as { words: string }
    expect(reported.words).toContain("is now hot")
    expect(reported.words).toContain(`momentum's default in config.toml (agents.momentum.wallet = "tee-one") still pays from it, by its address: change the line to "hot" when you like.`)
    // The key's rows are read again before the report answers; the portfolio's label may follow later (its read
    // waits on the key's budget under load), so what's held here is the address, whatever the label reads now.
    expect(t.core.wallets.payable("momentum").tee.map((w) => w.address)).toEqual([TEE])
    expect(t.core.wallets.payer("momentum")).toMatchObject({ ok: true, kind: "tee", address: TEE })
    // And across a restart: the pin is in the state folder, not in memory.
    expect(JSON.parse(readFileSync(t.p.defaultPins, "utf8")).pins.momentum).toEqual({ setting: "tee-one", address: TEE })
  }, 30_000)

  test("a rename while a card waits: the card pays the same address it was made for", async () => {
    const s = await setup()
    const answer = await s.tool("candle_trade", { side: "buy", mint: "MoonFake11111111111111111111111111111111111", amount: "0.01", wallet: "tee-one" })
    expect(answer.error.code).toBe("APPROVAL_REQUIRED")
    const card = s.t.core.cards.get(answer.cardId)! as Card & { params: { cli?: string[] } }
    expect(JSON.stringify(card.params)).toContain(TEE)
    expect(JSON.stringify(card.params)).not.toContain("tee-one")
    await s.view.request("wallets.name", { wallet: "embedded", name: "tee-one-2" })
    expect((s.t.core.cards.get(answer.cardId)! as Card).cardHash).toBe(card.cardHash)
  }, 30_000)

  test("names survive a restart: wallets.toml is read when the core starts", async () => {
    let embedded = ""
    {
      const s = await setup()
      embedded = s.embedded
    }
    const s = await setup(undefined, (p) => writeFileSync(p.walletsFile, `[names]\n"${embedded}" = "main"\n`))
    // The fake account's embedded wallet is the same in every home.
    expect(s.embedded).toBe(embedded)
    expect(names(s.t).find((e) => e.address === s.embedded)?.name).toBe("main")
    expect(s.t.core.wallets.payer("momentum", "main")).toMatchObject({ ok: true, kind: "embedded" })
  }, 30_000)

  test("a Candle label two wallets share is shown, marked, and taken by address only", async () => {
    const other = "TeeFake222222222222222222222222222222222222"
    const s = await setup([
      { id: "teeA", address: TEE, label: "twin", boundKeyPrefix: "Momentum" },
      { id: "teeB", address: other, label: "Twin", boundKeyPrefix: "Momentum" },
    ])
    expect(names(s.t).filter((e) => e.marked).map((e) => e.address).sort()).toEqual([TEE, other].sort())
    expect(s.t.core.wallets.payer("momentum", "twin")).toMatchObject({ ok: false, code: "WALLET_AMBIGUOUS" })
    expect(s.t.core.wallets.payer("momentum", other)).toMatchObject({ ok: true, address: other })
    expect((await s.view.request("wallets.name", { wallet: "twin", name: "x" })).error?.data?.code).toBe("WALLET_AMBIGUOUS")
  }, 30_000)

  test("50 renames are one --pairs-from run, its preview first; one refused name refuses them all before anything runs", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `tee${i}`, address: teeN(i), label: `bot-${i}`, boundKeyPrefix: "Momentum" }))
    const s = await setup(many)
    const asks = many.map((w, i) => ({ wallet: w.label, name: `desk-${i}` }))
    const r = (await s.view.request("wallets.name", { names: asks })).result as { panes: { ticket: string; ticketId: string }[] }
    expect(r.panes).toHaveLength(1)
    const { redeemed } = await openPane(s.t, s.view, r.panes[0]!)
    expect(redeemed.steps.map((x) => x.stage).filter((x) => x !== "factor")).toEqual(["preview", "command"])
    const command = redeemed.steps.at(-1)!.argv
    expect(command.slice(0, 3)).toEqual(["tee", "rename", "--pairs-from"])
    expect(redeemed.steps.find((x) => x.stage === "preview")!.argv).toEqual([...command, "--dry-run"])
    expect(readFileSync(command[3]!, "utf8")).toBe(pairsFile(many.map((w, i) => ({ address: w.address, name: `desk-${i}` }))))

    const cards = s.t.core.cards.list().length
    const files = readdirSync(s.t.p.renamesDir).length
    const refused = await s.view.request("wallets.name", { names: [...asks.slice(0, 49).map((a) => ({ ...a, name: `${a.name}x` })), { wallet: "bot-49", name: "embedded" }] })
    expect(refused.error?.data?.code).toBe("NAME_REFUSED")
    expect(s.t.core.cards.list().length).toBe(cards)
    expect(readdirSync(s.t.p.renamesDir).length).toBe(files)
  }, 60_000)

  test("the agent's naming at once has an undo, which puts the names back", async () => {
    const s = await setup()
    const answer = await s.tool("harness_name_wallets", { names: [{ wallet: "embedded", name: "main" }] })
    expect(answer).toMatchObject({ success: true })
    expect(answer.done).toContain("undo")
    const row = s.t.core.journal.rows().find((x) => x.type === "wallets.named") as unknown as { changeId: string; agent?: string }
    expect(row.agent).toBe("momentum")
    // The wallets topic, as a view gets it, carries the naming and its agent: what puts the undo under the reply.
    const late = await s.t.view()
    await late.request("subscribe", { topics: ["wallets"] })
    await until(() => late.events.some((e) => e.topic === "wallets"))
    const topic = late.events.findLast((e) => e.topic === "wallets")!.data as { named?: { changeId: string; agent?: string; words: string } }
    expect(topic.named).toMatchObject({ changeId: row.changeId, agent: "momentum", words: "embedded → main" })
    const undone = (await s.view.request("wallets.undo", { changeId: row.changeId })).result as { said: string }
    expect(undone.said).toContain("Undone")
    expect(readFileSync(s.t.p.walletsFile, "utf8")).not.toContain(s.embedded)
    expect(s.t.core.wallets.payer("momentum", "main")).toMatchObject({ ok: false })
    expect((await s.view.request("wallets.undo", { changeId: row.changeId })).error?.data?.code).toBe("NOTHING_TO_UNDO")
  }, 30_000)
})
