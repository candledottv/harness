// Empty token accounts: Candle's close-empty preview read through the user's own CLI.
// The preview's words are the CLI's own, from cli/src/commands/wallets-close-empty.test.ts at 0.13.5's
// commit 7a980a6 (the TEE fixture: three accounts, two transactions).
import { describe, expect, test } from "bun:test"
import { EmptyAccountsBook, isCounted, PREVIEW_CALLS, previewArgv, readPreview } from "./empty-accounts"
import { FREE_LIMIT, KeyBudget } from "./key-budget"

const TEE = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const STDERR = [
  `Close 3 empty token accounts on the TEE wallet agent-one (${TEE})`,
  "Rent returned to that same wallet: 0.00615264 SOL in 2 transactions, network fee about 0.00001 SOL, net 0.00614264 SOL",
  "  MintA  token-2022  0.00207408 SOL",
  "Left open: 1 kept by --keep",
  "",
].join("\n")
const confirm = { exitCode: 1, timedOut: false, stderr: STDERR, json: { ok: false, code: "CONFIRMATION_REQUIRED", message: "Run interactively to confirm, or use --yes to close without a prompt." } }

describe("the preview, read", () => {
  test("the preview's argv never closes: no --yes, no id", () => {
    expect(previewArgv(TEE)).toEqual(["wallets", "close-empty", "--wallet", TEE, "--json"])
  })

  test("with some to close: the count and the SOL from the CLI's own lines, and the cap where Candle has one", () => {
    expect(readPreview(confirm, 5)).toEqual({ count: 3, totalSol: "0.00615264", transactions: 2, feeSol: "0.00001", netSol: "0.00614264", at: 5 })
    const capped = { ...confirm, stderr: `${STDERR}This run closes the first 200; run it again for the rest.\n`.replace("Close 3", "Close 240") }
    expect(readPreview(capped, 5)).toMatchObject({ count: 240, firstOnly: 200 })
    const one = { ...confirm, stderr: "Close 1 empty token account on the TEE wallet x\nRent returned to that same wallet: 0.00203928 SOL in 1 transaction, network fee about 0.000005 SOL, net 0.00203428 SOL\n" }
    expect(readPreview(one, 5)).toMatchObject({ count: 1, transactions: 1, netSol: "0.00203428" })
  })

  test("nothing to close is a count of none, from the JSON on stdout", () => {
    const run = { exitCode: 0, timedOut: false, stderr: "No empty token accounts to close on the TEE wallet x.\n", json: { success: true, status: "nothing_to_close", wallet: TEE, preview: { accounts: [], accountCount: 0, estimatedFeeLamports: "0" } } }
    expect(readPreview(run, 5)).toEqual({ count: 0, netSol: "0", totalSol: "0", feeSol: "0", transactions: 0, at: 5 })
  })

  test("anything else is unread, in Candle's words or why, never a guess", () => {
    const off = readPreview({ exitCode: 1, timedOut: false, stderr: "", json: { ok: false, code: "CLOSE_EMPTY_DISABLED", message: "Not enabled here." } }, 5)
    expect(off).toEqual({ code: "CLOSE_EMPTY_DISABLED", failed: "Not enabled here.", at: 5 })
    expect(isCounted(off)).toBe(false)
    expect(readPreview({ ...confirm, stderr: "Something new\n" }, 5)).toMatchObject({ code: "PREVIEW_UNREAD" })
    expect(readPreview({ ...confirm, stderr: STDERR.replace(/^Rent.*$/m, "") }, 5)).toMatchObject({ code: "PREVIEW_UNREAD" })
    expect(readPreview({ exitCode: 0, timedOut: false, stderr: "", json: { success: true, status: "completed" } }, 5)).toMatchObject({ code: "UNEXPECTED" })
    expect(readPreview({ exitCode: 0, timedOut: true, stderr: "", json: undefined }, 5)).toMatchObject({ code: "TIMED_OUT" })
    expect(readPreview({ exitCode: 1, timedOut: false, stderr: "", json: undefined }, 5)).toMatchObject({ code: "UNREADABLE" })
  })
})

function book(opts: { take?: (agent: string) => string | undefined; answers?: (typeof confirm)[] } = {}) {
  const runs: { agent: string; argv: string[]; calls: number }[] = []
  const answers = [...(opts.answers ?? [confirm])]
  let changes = 0
  const b = new EmptyAccountsBook({
    wallets: () => [{ address: TEE, agent: "momentum" }],
    run: async (input) => {
      runs.push({ agent: input.agent, argv: input.argv, calls: input.calls })
      return answers.length > 1 ? answers.shift()! : answers[0]!
    },
    take: opts.take ?? ((agent) => agent),
    now: () => 7,
    onChange: () => changes++,
    settleDelayMs: 5,
    retryMs: 5,
    startDelayMs: 5,
  })
  return { b, runs, changes: () => changes }
}

const until = async (ok: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

describe("the book", () => {
  test("a read runs the preview with the wallet's own agent's key, counted as four of Candle's calls", async () => {
    const { b, runs, changes } = book()
    await b.read(TEE)
    expect(runs).toEqual([{ agent: "momentum", argv: previewArgv(TEE), calls: PREVIEW_CALLS }])
    expect(b.view()[TEE]).toMatchObject({ count: 3, netSol: "0.00614264" })
    expect(changes()).toBe(1)
    // A wallet no agent pays from isn't read, and isn't shown.
    await b.read("SomeoneElse1111111111111111111111111111111")
    expect(runs).toHaveLength(1)
  })

  test("the count is read again after a sell from the wallet settles", async () => {
    const after = { exitCode: 0, timedOut: false, stderr: "", json: { success: true, status: "nothing_to_close", preview: { estimatedFeeLamports: "0" } } }
    const { b, runs } = book({ answers: [{ ...confirm, stderr: STDERR.replace("Close 3", "Close 2") }, confirm, after as unknown as typeof confirm] })
    await b.read(TEE)
    expect((b.get(TEE) as { count: number }).count).toBe(2)
    b.afterSettle(TEE)
    // Twice in a row is one read.
    b.afterSettle(TEE)
    await until(() => runs.length === 2)
    await until(() => (b.get(TEE) as { count: number }).count === 3)
    b.afterSettle("SomeoneElse1111111111111111111111111111111")
    await Bun.sleep(30)
    expect(runs).toHaveLength(2)
    b.close()
  })

  test("turned back by the key's budget, nothing runs, and it's tried again a little later", async () => {
    let room = false
    const { b, runs } = book({ take: (agent) => (room ? agent : undefined) })
    await b.read(TEE)
    expect(runs).toEqual([])
    expect(b.get(TEE)).toBeUndefined()
    room = true
    await until(() => runs.length === 1)
    b.close()
  })

  test("nothing is read until a view has been attached past the start delay; a wallet first seen then is read", async () => {
    const { b, runs } = book()
    b.walletsChanged()
    await Bun.sleep(20)
    expect(runs).toEqual([])
    b.start()
    await until(() => runs.length === 1)
    expect(b.perMin()).toBeCloseTo(1 / 30)
    b.stop()
    expect(b.perMin()).toBe(0)
    b.close()
  })
})

describe("the budget at Free's 30", () => {
  test("a preview takes four calls' room and is counted as four; with the key busy it waits, and a card's reserve is kept", () => {
    let now = 1_000_000
    const budget = new KeyBudget({ limitOf: () => FREE_LIMIT, agents: () => ["momentum"], preferred: () => "momentum", now: () => now })
    budget.want("empty", { perMin: () => 1 / 30, naturalMs: 30 * 60_000 })
    expect(budget.take("empty", "momentum", PREVIEW_CALLS)).toBe("momentum")
    budget.noteCall("momentum", PREVIEW_CALLS)
    expect(budget.use()[0]).toMatchObject({ used: 4, background: 4, allowance: 15 })
    // Turns and cards used most of the minute: 21 + 4 leaves 5, the card's reserve, so the preview waits.
    budget.noteCall("momentum", 21)
    expect(budget.take("empty", "momentum", PREVIEW_CALLS)).toBeUndefined()
    // A minute on, there's room again, up to half the key's limit: a fourth preview (16) would pass 15.
    now += 61_000
    expect(budget.take("empty", "momentum", PREVIEW_CALLS)).toBe("momentum")
    expect(budget.take("empty", "momentum", PREVIEW_CALLS)).toBe("momentum")
    expect(budget.take("empty", "momentum", PREVIEW_CALLS)).toBe("momentum")
    expect(budget.take("empty", "momentum", PREVIEW_CALLS)).toBeUndefined()
  })
})
