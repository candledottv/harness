// Wallet groups through a running core: made from a view and by the agent with an
// undo, kept in wallets.toml beside the names, on the `wallets` topic, followed through a rename, and never paying:
// `from <group>` is refused by the core and by a view's own check alike.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { payerContextFrom, resolvePayer, type WalletsTopic } from "./agent-wallets"
import { fiftyFakeTees, fiftyToml } from "../../test/wallets-scene"

afterAll(() => cleanupHomes())

/** The fake Candle's embedded wallet (fake-candle-mcp.ts's, which can't be imported outside its process). */
const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const tee = (i: number) => ({ id: `tee${i}`, address: `Tee${String(i).padStart(2, "0")}${"1".repeat(39)}`, label: `bot-${String(i).padStart(2, "0")}`, boundKeyPrefix: "Momentum" })
const TEES = [1, 2, 3, 4].map(tee)

describe("wallet groups through a running core", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })

  async function setup(before?: (p: TestCore["p"]) => void) {
    const t = await startTestCore({}, { keys: { momentum: prefixedKey("Momentum") }, candle: { momentum: { teeWallets: TEES } }, config: { mode: "live" }, ...(before ? { before } : {}) })
    cores.push(t)
    const view = await t.view()
    const { client: harness } = await t.harness(view)
    const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(((await harness.request("tools.call", { name, args })).result as { content: { text: string }[] }).content[0]!.text)
    await until(() => t.core.wallets.teeOnKey("Momentum").length === TEES.length && t.core.wallets.payable("momentum").embedded !== undefined)
    const groups = () => t.core.wallets.view().groups ?? []
    return { t, view, harness, tool, groups }
  }

  test("a group made from a view: kept in wallets.toml, on the topic, a prefix taking in its wallets", async () => {
    const s = await setup()
    const r = (await s.view.request("wallets.group", { group: "bots", op: "prefix", prefix: "bot-*" })).result as { said: string; changeId: string }
    expect(r.said).toBe("Made the group bots: every wallet whose name starts bot- (4 now).")
    expect(readFileSync(s.t.p.walletsFile, "utf8")).toContain('[groups.bots]\nprefix = "bot-"\n')
    expect(s.groups()).toEqual([{ name: "bots", prefix: "bot-", list: [], members: TEES.map((w) => w.address), unknown: [] }])
    // A hand-picked group beside it, by name, kept by address.
    await s.view.request("wallets.group", { group: "pair", op: "add", wallets: ["bot-01", "embedded"] })
    const pair = s.groups().find((g) => g.name === "pair")!
    expect(pair.members).toEqual([s.t.core.wallets.payable("momentum").embedded!.address, TEES[0]!.address])
    expect(s.t.core.journal.rows().filter((row) => row.type === "wallets.grouped")).toHaveLength(2)
  }, 30_000)

  test("a group never pays: `from bots` is refused in the core's words, and a view's own check says the same", async () => {
    const s = await setup()
    await s.view.request("wallets.group", { group: "bots", op: "prefix", prefix: "bot-" })
    const r = s.t.core.wallets.payer("momentum", "BOTS")
    expect(r).toMatchObject({ ok: false, code: "WALLET_IS_GROUP" })
    expect((r as { message: string }).message).toContain("BOTS is a group, and a group never pays: name one wallet in it, such as bot-01.")
    const topic = s.t.core.wallets.view() as WalletsTopic
    expect(resolvePayer(payerContextFrom(topic, "momentum")!, "BOTS")).toEqual(r)
    // A trade from the agent naming the group makes no card.
    const answer = await s.tool("candle_trade", { side: "buy", mint: "MoonFake11111111111111111111111111111111111", amount: "0.01", wallet: "bots" })
    expect(answer.error.code).toBe("WALLET_IS_GROUP")
    expect(s.t.core.cards.list().length).toBe(0)
  }, 30_000)

  test("the agent makes a group at once, and the person's undo puts it back as it was", async () => {
    const s = await setup()
    await s.view.request("wallets.group", { group: "pair", op: "add", wallets: ["bot-01"] })
    const answer = await s.tool("harness_group_wallets", { group: "pair", add: ["bot-02", "bot-03"] })
    expect(answer).toMatchObject({ success: true, done: "Added bot-02 and bot-03 to pair: at once; the person can undo it under your reply." })
    expect(s.groups()[0]!.members).toEqual(TEES.slice(0, 3).map((w) => w.address))
    await s.view.request("subscribe", { topics: ["wallets"] })
    await until(() => s.view.events.some((e) => e.topic === "wallets"))
    const grouped = (s.view.events.filter((e) => e.topic === "wallets").at(-1)!.data as WalletsTopic & { grouped?: { changeId: string; agent?: string; words: string } }).grouped
    expect(grouped).toMatchObject({ agent: "momentum", words: "added bot-02 and bot-03 to pair" })
    const undone = (await s.view.request("wallets.undo", { changeId: grouped!.changeId })).result as { said: string }
    expect(undone.said).toBe("Undone: added bot-02 and bot-03 to pair, as momentum did.")
    expect(s.groups()[0]!.members).toEqual([TEES[0]!.address])
    // The agent can't undo, and an old change can't be undone twice.
    expect((await s.view.request("wallets.undo", { changeId: grouped!.changeId })).error?.data?.code).toBe("NOTHING_TO_UNDO")
  }, 30_000)

  test("a change that can't be made says why, and nothing is written", async () => {
    const s = await setup()
    for (const [args, code] of [
      [{ group: "my bots", op: "add", wallets: ["bot-01"] }, "GROUP_NAME_REFUSED"],
      [{ group: "momentum", op: "add", wallets: ["bot-01"] }, "GROUP_NAME_REFUSED"],
      [{ group: "bots", op: "add", wallets: ["nobody"] }, "UNKNOWN_WALLET"],
      [{ group: "bots", op: "delete" }, "UNKNOWN_GROUP"],
      [{ group: "bots", op: "prefix", prefix: " x" }, "PREFIX_REFUSED"],
    ] as const) {
      expect(`${JSON.stringify(args)}: ${(await s.view.request("wallets.group", args)).error?.data?.code}`).toBe(`${JSON.stringify(args)}: ${code}`)
    }
    expect((await s.view.request("wallets.group", { group: "bots", op: "nope" })).error?.code).toBe(-32602)
    expect(s.groups()).toEqual([])
    // A hand edit with a problem is never written over.
    writeFileSync(s.t.p.walletsFile, "[groups.bad]\nprefix = 3\n")
    expect((await s.view.request("wallets.group", { group: "bots", op: "prefix", prefix: "bot-" })).error?.data?.code).toBe("WALLETS_FILE_PROBLEM")
    expect(readFileSync(s.t.p.walletsFile, "utf8")).toBe("[groups.bad]\nprefix = 3\n")
  }, 30_000)

  test("groups survive a restart, and a hand edit is read with them", async () => {
    let s = await setup((p) => writeFileSync(p.walletsFile, `[groups.tens]\nwallets = ["bot-01", "bot-99"]\n`))
    expect(s.groups()).toEqual([{ name: "tens", list: ["bot-01", "bot-99"], members: [TEES[0]!.address], unknown: ["bot-99"] }])
    await s.view.request("wallets.group", { group: "tens", op: "add", wallets: ["bot-02"] })
    const home = s.t.p
    await cores.splice(0)[0]!.close()
    s = await setup((p) => writeFileSync(p.walletsFile, readFileSync(home.walletsFile, "utf8")))
    expect(s.groups()[0]!.members).toEqual([TEES[0]!.address, TEES[1]!.address])
  }, 30_000)

  test("fifty wallets on two keys: grouped from a hand-written wallets.toml, each group's wallets on the topic", async () => {
    const tees = fiftyFakeTees("Momentum", "SwingKey")
    const t = await startTestCore({}, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("SwingKey") }, candle: { momentum: { teeWallets: tees }, swing: { teeWallets: tees } }, config: { mode: "live" }, before: (p) => writeFileSync(p.walletsFile, fiftyToml(FAKE_WALLET)) })
    cores.push(t)
    await until(() => t.core.wallets.teeOnKey("Momentum").length + t.core.wallets.teeOnKey("SwingKey").length === 49)
    // The names come with the portfolio, read once a view attaches.
    await t.view()
    await until(() => (t.core.wallets.view().groups ?? []).find((g) => g.name === "bots")?.members.length === 24)
    const counts = Object.fromEntries((t.core.wallets.view().groups ?? []).map((g) => [g.name, g.members.length]))
    expect(counts).toEqual({ bots: 24, copy: 6, lp: 3, snipers: 8, swing: 5 })
    expect((t.core.wallets.view().groups ?? []).every((g) => g.unknown.length === 0)).toBe(true)
    // The embedded wallet goes by the Candle Harness's name from the file, and three wallets are in no group.
    expect(t.core.wallets.view().names?.find((e) => e.address === FAKE_WALLET)?.name).toBe("main")
    const grouped = new Set((t.core.wallets.view().groups ?? []).flatMap((g) => g.members))
    expect(tees.filter((w) => !grouped.has(w.address)).map((w) => w.label)).toEqual(["beta", "scratch", "old-tee"])
  }, 30_000)
})
