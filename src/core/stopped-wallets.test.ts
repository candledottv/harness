// A TEE wallet stopped in the prompt pane: `tee disable` is final, and Candle
// then drops the wallet from every list. The core keeps it, shows it, tells the agent, and lets it go
// once a sweep in the pane retires it.
import { afterAll, afterEach, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import { HOOD_SWEEP_NOTE } from "./cli-tool"
import { STOPPED_FOR_GOOD, SWEPT_AND_RETIRED } from "./pane-plan"
import type { PortfolioView } from "./portfolio-view"
import { listsEveryTee, StoppedWallets, stoppedNote } from "./stopped-wallets"
import { shownWallets } from "./wallets-shown"

const TEE = "TeeFake111111111111111111111111111111111111"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())

const latest = <T,>(view: TestClient, topic: string): T | undefined => view.events.filter((e) => e.topic === topic).at(-1)?.data as T | undefined

/** Runs an approved pane card to the end, this process playing the launcher. */
async function runPane(c: TestCore, view: TestClient, opened: { ticket: string; ticketId: string }, exit: number): Promise<{ outcome: string; words: string }> {
  await view.request("pane.spawned", { ticketId: opened.ticketId, pid: process.pid })
  const { client: pane } = await c.hello(opened.ticket)
  await pane.request("pane.redeem")
  return (await pane.request("pane.report", { stage: "command", exit })).result as { outcome: string; words: string }
}

test("a stop that finished: said to be for good, a chip types the sweep, and the wallet stays on the Wallets pane until a sweep retires it", async () => {
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["portfolio"] })
  const { client: harness } = await c.harness(view)
  const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [TEE] } })
  const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
  expect(card.display.warning).toContain("Candle never re-enables a stopped TEE wallet")
  const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { ticket: string; ticketId: string }
  const told = await runPane(c, view, approved, 0)
  expect(told.words).toBe(STOPPED_FOR_GOOD)
  expect((c.core.operations.get(card.opId)!.result as { pane: { next: unknown } }).pane.next).toEqual([{ label: "sweep it home", line: `candle tee sweep ${TEE} as momentum` }])

  // Candle no longer lists it; the core does, as stopped, and "active" still shows it.
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === TEE) === true)
  const shown = latest<PortfolioView>(view, "portfolio")!.wallets.find((w) => w.address === TEE)!
  expect(shown).toMatchObject({ kind: "tee", agents: ["momentum"], active: false, stopped: true, native: null })
  expect(shownWallets([shown], "active").shown).toHaveLength(1)
  expect(statSync(c.p.stoppedWallets).mode & 0o777).toBe(0o600)

  // The sweep, typed: the core lets it go once it finished.
  const sweep = (await view.request("cli.run", { argv: ["tee", "sweep", TEE] })).result as { kind: string; ticket: string; ticketId: string }
  expect(sweep.kind).toBe("pane")
  expect((await runPane(c, view, sweep, 0)).words).toBe(SWEPT_AND_RETIRED)
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === TEE) === false)
  // Funding it now is refused before anything runs.
  const fund = await view.request("cli.run", { argv: ["vault", "fund", TEE, "--asset", "SOL", "--amount", "0.01"] })
  expect(JSON.stringify(fund)).toContain("RETIRED_DESTINATION")
})

test("a stop asked for but not confirmed (exit 3) is remembered too, with no sweep chip yet", async () => {
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  const { client: harness } = await c.harness(view)
  const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [TEE] } })
  const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
  const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { ticket: string; ticketId: string }
  expect((await runPane(c, view, approved, 3)).outcome).toBe("pending")
  expect((c.core.operations.get(card.opId)!.result as { pane: { next?: unknown } }).pane.next).toBeUndefined()
  const kept = new StoppedWallets({ file: c.p.stoppedWallets })
  await kept.load()
  expect(kept.all()).toEqual([{ address: TEE, agent: "momentum", at: expect.any(String), confirmed: false }])
})

test("the list survives a reload; a bad entry is dropped; the agent's note names only its own", async () => {
  const c = await startTestCore()
  cores.push(c)
  const a = new StoppedWallets({ file: c.p.stoppedWallets })
  await a.stopped({ address: TEE, label: "desk", agent: "momentum" }, { now: 0, confirmed: true })
  const b = new StoppedWallets({ file: c.p.stoppedWallets })
  await b.load()
  expect(b.all()).toEqual([{ address: TEE, label: "desk", agent: "momentum", at: "1970-01-01T00:00:00.000Z", confirmed: true }])
  await Bun.write(c.p.stoppedWallets, JSON.stringify({ stopped: [{ address: "not an address", at: "x" }, ...b.all()] }))
  await b.load()
  expect(b.all()).toHaveLength(1)
  expect(stoppedNote(b.all(), "momentum")).toContain(`desk (${TEE})`)
  expect(stoppedNote(b.all(), "momentum")).toContain("candle tee enable won't bring it back")
  expect(stoppedNote(b.all(), "swing")).toBeUndefined()
  expect(b.gone(TEE)).toBe("stopped")
  await b.swept(TEE, 1000)
  expect(b.all()).toEqual([])
  // Retired, and kept so: nothing sends funds there again, across a restart too.
  expect(b.gone(TEE)).toBe("retired")
  const c2 = new StoppedWallets({ file: c.p.stoppedWallets })
  await c2.load()
  expect(c2.gone(TEE)).toBe("retired")
  expect(c2.all()).toEqual([])
  expect(c2.gone("Other111111111111111111111111111111111111111")).toBeUndefined()
})

test("a rename in the pane: a stopped or retired wallet's kept label follows it by address", async () => {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const file = join(mkdtempSync(join(tmpdir(), "chrn-stopped-names-")), "stopped.json")
  const a = "StopA111111111111111111111111111111111111111"
  const b = "StopB222222222222222222222222222222222222222"
  const w = new StoppedWallets({ file })
  await w.stopped({ address: a, label: "old-a" }, { now: 1, confirmed: true })
  await w.stopped({ address: b, label: "old-b" }, { now: 1, confirmed: true })
  await w.swept(b, 2)
  await w.relabel([{ address: a, name: "new-a" }, { address: b, name: "new-b" }])
  const again = new StoppedWallets({ file })
  await again.load()
  expect(again.all().map((x) => x.label)).toEqual(["new-a"])
  expect(again.retired()).toEqual([{ address: b, label: "new-b" }])
})

test("a TEE wallet Candle stops listing: kept as stopped outside the Candle Harness after two reads without it, and let go if it's listed again", async () => {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const file = join(mkdtempSync(join(tmpdir(), "chrn-stopped-outside-")), "stopped.json")
  const a = "SeenA111111111111111111111111111111111111111"
  const b = "SeenB222222222222222222222222222222222222222"
  const w = new StoppedWallets({ file })
  await w.listed([{ address: a, label: "hot", agent: "momentum" }, { address: b }], 1, "Acct1111111111111111111111111111111111111111")
  // One read without it could be Candle's hiccup: nothing yet.
  await w.listed([{ address: b }], 2, "Acct1111111111111111111111111111111111111111")
  expect(w.all()).toEqual([])
  await w.listed([{ address: b }], 3, "Acct1111111111111111111111111111111111111111")
  expect(w.all()).toEqual([{ address: a, label: "hot", agent: "momentum", at: new Date(3).toISOString(), confirmed: false, outside: true }])
  expect(w.gone(a)).toBe("stopped")
  expect(stoppedNote(w.all(), "momentum")).toContain("which Candle stopped listing, as a stop outside the Candle Harness does")
  // Kept across a restart.
  const again = new StoppedWallets({ file })
  await again.load()
  expect(again.all().map((x) => [x.address, x.outside])).toEqual([[a, true]])
  // Listed again: it wasn't stopped after all.
  await again.listed([{ address: a, label: "hot" }, { address: b }], 4, "Acct1111111111111111111111111111111111111111")
  expect(again.all()).toEqual([])
  // Another account's portfolio: the first account's wallets aren't missing, they're someone else's.
  await again.listed([], 5, "Acct2222222222222222222222222222222222222222")
  await again.listed([], 6, "Acct2222222222222222222222222222222222222222")
  expect(again.all()).toEqual([])
})

test("a cut-off wallet list says nothing about which TEE wallets are missing: a live wallet it leaves out isn't marked stopped", async () => {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const a = "SeenA111111111111111111111111111111111111111"
  const b = "SeenB222222222222222222222222222222222222222"
  const tee = (...addresses: string[]) => addresses.map((address) => ({ chain: "solana", address }))
  // walletsComplete: false is a cut-off list; with no walletsComplete (an older server), complete: false may be one.
  expect(listsEveryTee({ tee: tee(b), walletsComplete: false, complete: false })).toBe(false)
  expect(listsEveryTee({ tee: tee(b), walletsComplete: false, complete: true })).toBe(false)
  expect(listsEveryTee({ tee: tee(b), complete: false })).toBe(false)
  // A walletsComplete that isn't a plain true reads as cut off, never as whole.
  expect(listsEveryTee({ tee: tee(b), walletsComplete: null })).toBe(false)
  expect(listsEveryTee({ tee: tee(b), walletsComplete: "false" })).toBe(false)
  expect(listsEveryTee({ tee: tee(b), walletsComplete: "true", complete: true })).toBe(false)
  // A failed balance read with the whole list is still a whole list.
  expect(listsEveryTee({ tee: tee(b), walletsComplete: true, complete: false })).toBe(true)
  expect(listsEveryTee({ tee: tee(b), walletsComplete: true, complete: true })).toBe(true)
  expect(listsEveryTee({ tee: tee(b) })).toBe(true)
  expect(listsEveryTee({ tee: [], walletsComplete: true })).toBe(true)
  // No TEE list at all, or no body: nothing to say.
  expect(listsEveryTee({ walletsComplete: true })).toBe(false)
  expect(listsEveryTee(undefined)).toBe(false)
  // The core's gate on each read (core-main.ts, noteTeeListed): a stable cut at the same place never marks a.
  const w = new StoppedWallets({ file: join(mkdtempSync(join(tmpdir(), "chrn-stopped-cut-")), "stopped.json") })
  const reads = [
    { tee: tee(a, b), walletsComplete: true, complete: true },
    { tee: tee(b), walletsComplete: false, complete: false },
    { tee: tee(b), walletsComplete: false, complete: false },
    { tee: tee(b), complete: false },
    { tee: tee(b), complete: false },
  ]
  for (const [i, body] of reads.entries()) {
    if (listsEveryTee(body)) await w.listed(body.tee.map((t) => ({ address: t.address })), i + 1, "Acct1111111111111111111111111111111111111111")
  }
  expect(w.all()).toEqual([])
  expect(w.gone(a)).toBeUndefined()
})

test("a listed address that isn't a Solana address is never kept, shown or typed into a sweep", async () => {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const bad = "Bad1111111111111111111111111111111; rm -rf ~"
  const w = new StoppedWallets({ file: join(mkdtempSync(join(tmpdir(), "chrn-stopped-bad-")), "stopped.json") })
  await w.listed([{ address: bad }], 1, "Acct1111111111111111111111111111111111111111")
  await w.listed([], 2, "Acct1111111111111111111111111111111111111111")
  await w.listed([], 3, "Acct1111111111111111111111111111111111111111")
  expect(w.all()).toEqual([])
  expect(w.gone(bad)).toBeUndefined()
})

test("a Hood TEE wallet stopped in the pane by its 0x address is kept as stopped, and the sweep chip follows, as on Solana", async () => {
  const HOOD = "0xAbCdEf0123456789aBcDeF0123456789abCDef01"
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["portfolio"] })
  const { client: harness } = await c.harness(view)
  const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [HOOD] } })
  const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
  const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { ticket: string; ticketId: string }
  expect((await runPane(c, view, approved, 0)).words).toBe(STOPPED_FOR_GOOD)
  expect((c.core.operations.get(card.opId)!.result as { pane: { next: unknown } }).pane.next).toEqual([{ label: "sweep it home", line: `candle tee sweep ${HOOD} as momentum` }])
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === HOOD && w.stopped === true) === true)
  const kept = new StoppedWallets({ file: c.p.stoppedWallets })
  await kept.load()
  expect(kept.all().map((w) => [w.address, w.confirmed])).toEqual([[HOOD, true]])

  // The sweep by its 0x address: its card says what a Hood sweep needs, and once it finished the wallet is retired.
  // Typed by the person, as funds out are: the pane opens at once, and its card carries the note.
  const sweep = (await view.request("cli.run", { argv: ["tee", "sweep", HOOD] })).result as { ticket: string; ticketId: string; card: { cardId: string } }
  expect(c.core.cards.get(sweep.card.cardId)!.display.paneNotes).toContain(HOOD_SWEEP_NOTE)
  expect((await runPane(c, view, sweep, 0)).words).toBe(SWEPT_AND_RETIRED)
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === HOOD) === false)
  const fund = await view.request("cli.run", { argv: ["vault", "fund", HOOD, "--asset", "ETH", "--amount", "0.001"] })
  expect(JSON.stringify(fund)).toContain("RETIRED_DESTINATION")
})

test("a Hood sweep typed with --token before the wallet retires the wallet, never the token", async () => {
  const HOOD = "0x00000000000000000000000000000000000c0C01"
  const TOKEN = "0x00000000000000000000000000000000000d0D01"
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["portfolio"] })
  const { client: harness } = await c.harness(view)
  const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [HOOD] } })
  const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
  const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { ticket: string; ticketId: string }
  expect((await runPane(c, view, approved, 0)).words).toBe(STOPPED_FOR_GOOD)
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === HOOD && w.stopped === true) === true)

  const sweep = (await view.request("cli.run", { argv: ["tee", "sweep", "--token", TOKEN, HOOD] })).result as { ticket: string; ticketId: string }
  expect((await runPane(c, view, sweep, 0)).words).toBe(SWEPT_AND_RETIRED)
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === HOOD) === false)
  const kept = new StoppedWallets({ file: c.p.stoppedWallets })
  await kept.load()
  expect(kept.all()).toEqual([])
  expect(JSON.stringify(await view.request("cli.run", { argv: ["vault", "fund", HOOD, "--asset", "ETH", "--amount", "0.001"] }))).toContain("RETIRED_DESTINATION")
})

test("a Hood TEE wallet's stop asked for but not confirmed (exit 3) is remembered, with no sweep chip yet; a Solana sweep's card has no Hood words", async () => {
  const HOOD = "0x00000000000000000000000000000000000b0B01"
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  const { client: harness } = await c.harness(view)
  const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [HOOD] } })
  const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
  const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { ticket: string; ticketId: string }
  expect((await runPane(c, view, approved, 3)).outcome).toBe("pending")
  expect((c.core.operations.get(card.opId)!.result as { pane: { next?: unknown } }).pane.next).toBeUndefined()
  const kept = new StoppedWallets({ file: c.p.stoppedWallets })
  await kept.load()
  expect(kept.all().map((w) => [w.address, w.confirmed])).toEqual([[HOOD, false]])
  const solana = (await view.request("cli.run", { argv: ["tee", "sweep", TEE] })).result as { card: { cardId: string } }
  expect(c.core.cards.get(solana.card.cardId)!.display.paneNotes ?? []).not.toContain(HOOD_SWEEP_NOTE)
})

test("through a running core: portfolio reads that cut the wallet list off never mark a live TEE wallet they leave out as stopped", async () => {
  const { writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { candleConfigDir } = await import("./candle-mcp")
  const live = { id: "teeA", address: "SeenA111111111111111111111111111111111111111", label: "hot", boundKeyPrefix: "Momentum" }
  const other = { id: "teeB", address: "SeenB222222222222222222222222222222222222222", boundKeyPrefix: "Momentum" }
  const c = await startTestCore({}, { candle: { momentum: { teeWallets: [live, other] }, swing: { teeWallets: [live, other] } } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["portfolio"] })
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === live.address) === true, 20_000)
  // From now on Candle cuts the list off before the live wallet.
  for (const agent of ["momentum", "swing"]) writeFileSync(join(candleConfigDir(c.p.stateDir, agent), "fake-candle.json"), JSON.stringify({ teeWallets: [other], walletsComplete: false }))
  // A fill makes the core read the portfolio again at 2 s and 8 s: two cut-off reads in a row.
  await c.core.journal.append({ type: "operation.succeeded", mode: "paper", agent: "momentum", opId: "fill-1" })
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === live.address) === false, 15_000)
  await new Promise((r) => setTimeout(r, 7_500))
  const shown = latest<PortfolioView>(view, "portfolio")!.wallets
  expect(shown.some((w) => w.address === live.address && w.stopped)).toBe(false)
  const { existsSync, readFileSync } = await import("node:fs")
  const kept = existsSync(c.p.stoppedWallets) ? (JSON.parse(readFileSync(c.p.stoppedWallets, "utf8")) as { stopped?: { address: string }[] }).stopped ?? [] : []
  expect(kept.map((w) => w.address)).toEqual([])
}, 40_000)

test("a wallet stopped outside the Candle Harness, then stopped in it: the Candle Harness's own stop replaces it; a sweep retires it", async () => {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const file = join(mkdtempSync(join(tmpdir(), "chrn-stopped-outside-")), "stopped.json")
  const a = "SeenA111111111111111111111111111111111111111"
  const w = new StoppedWallets({ file })
  await w.listed([{ address: a }], 1)
  await w.listed([], 2)
  await w.listed([], 3)
  expect(w.all()[0]!.outside).toBe(true)
  await w.stopped({ address: a }, { now: 4, confirmed: true })
  expect(w.all()).toEqual([{ address: a, at: new Date(4).toISOString(), confirmed: true }])
  await w.swept(a, 5)
  // Retired: never counted as missing again.
  await w.listed([], 6)
  await w.listed([], 7)
  expect(w.all()).toEqual([])
  expect(w.gone(a)).toBe("retired")
})

test("a stopped Hood wallet is kept across a core start, matched in any case, and read on Hood, never on Solana", async () => {
  const HOOD = "0xAbCdEf0123456789aBcDeF0123456789abCDef01"
  const read: string[] = []
  const c = await startTestCore(
    {
      chainBalance: async (address: string, chain: string) => {
        read.push(`${chain}:${address}`)
        return chain === "hood" ? { lamports: 4_000_000_000_000_000n, tokens: null, tokensError: "only the native balance is read on chain", readAt: Date.now() } : { error: "not read in tests", readAt: Date.now() }
      },
    },
    { before: (p) => void Bun.write(p.stoppedWallets, JSON.stringify({ stopped: [{ address: HOOD, label: "hood-desk", agent: "momentum", at: "2026-11-01T00:00:00.000Z", confirmed: true }, { address: TEE, at: "2026-11-01T00:00:00.000Z", confirmed: true }] })) },
  )
  cores.push(c)
  // Loaded from the file a past core left: the 0x wallet is still there.
  const kept = new StoppedWallets({ file: c.p.stoppedWallets })
  await kept.load()
  expect(kept.all().map((w) => w.address)).toEqual([HOOD, TEE])
  expect(kept.gone(HOOD.toLowerCase())).toBe("stopped")
  const view = await c.view()
  await view.request("subscribe", { topics: ["portfolio"] })
  await until(() => read.includes(`solana:${TEE}`))
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.address === HOOD && w.native !== null) === true)
  // Its ETH, in ETH; its tokens said as not read, never as none.
  expect(latest<PortfolioView>(view, "portfolio")!.wallets.find((w) => w.address === HOOD)).toMatchObject({ stopped: true, chain: "hood", nativeSymbol: "ETH", native: { amount: 0.004 }, balanceError: "only the native balance is read on chain" })
  expect(read).toContain(`hood:${HOOD}`)
  expect(read).not.toContain(`solana:${HOOD}`)
})
