// Offline build-path contracts (BE-3920) from an exact clean Candle source checkout: the reads a Solana buy's build
// makes before it has a transaction, recorded by running the API's own source against a stand-in connection and a
// stand-in Jupiter.
//   1. the warm blockhash (apps/api/src/services/jupiter/build-cache.ts): a hash younger than 1.5 s is served as is,
//      a burst shares one fetch, a failed fetch is never kept, and an expired hash is never served in its place;
//   2. the lookup tables: a table younger than 10 s is served as is, per address and per connection; a table the RPC
//      cannot read is never kept, and a dropped table is read again;
//   3. the web's buy as POST /jupiter/swap builds it (getSwapTransactionWithInputFee with the process's one
//      connection and no priority cap): a second buy inside the windows reads neither, a buy past them reads again,
//      the hash and its height are the RPC's own, the fee rides exactly as before, and a stale table that no longer
//      fits is read again once before the fee is given up;
//   4. the build handler's checks (/trade/agent/build): the route breaker and the linked payer read start together,
//      a tripped breaker still answers before the payer is used, and the refusal codes are the ones it had.
// The route handlers sit behind auth, Convex and the database; they have no process to run here. The recorder pins
// their source facts as text, from the same commit.
// Every fetch and every RPC is a stand-in; no address, key, signature or figure is real.
//   bun scripts/read-build-cache-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-build-cache-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "apps/api/src", "packages/shared")
const FILES = [
  "apps/api/src/services/jupiter/build-cache.ts",
  "apps/api/src/services/jupiter/swap.ts",
  "apps/api/src/routes/jupiter.ts",
  "apps/api/src/services/candle/client.ts",
  "apps/api/src/routes/trade-agent.ts",
  "apps/api/src/services/jupiter/dflow.ts",
]
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  files: FILES,
}
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)

// Candle's own fee table is a separate, process-long read; unset, the composer runs without it.
delete process.env.CANDLE_FEE_LOOKUP_TABLE
delete process.env.JUPITER_API_KEY
const realNow = Date.now
let clock = 1_790_000_000_000
Date.now = () => clock
const originalWarn = console.warn
console.warn = () => {}

// web3.js from the checkout's own tree, so the tables and keys below are the same classes the composer compares.
const web3 = await import(Bun.resolveSync("@solana/web3.js", join(checkout, dirname(FILES[1]!))))
const { AddressLookupTableAccount, Keypair, PublicKey, VersionedTransaction } = web3
const cache = await load(FILES[0]!)
const { cachedAddressLookupTable, forgetAddressLookupTables, freshLatestBlockhash } = cache
const { getSwapTransactionWithInputFee } = await load(FILES[1]!)
const { priorityFeeTx } = await load("apps/api/src/services/jupiter/testing/priority-fee-tx.ts")

// Made-up but valid base58 keys, generated per run; rows name them by role only.
const key = () => Keypair.generate().publicKey
const PAYER = key().toBase58()
const WSOL_ATA = key().toBase58()
const TABLE = key()
const OTHER_TABLE = key()
const FEE_COLLECTOR = key()
const WSOL_MINT = "So11111111111111111111111111111111111111112"
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const SYSTEM = "11111111111111111111111111111111"
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"
const QUOTE = { inputMint: WSOL_MINT, outputMint: USDC_MINT, inAmount: "100000000", outAmount: "7397539", otherAmountThreshold: "7323564", swapMode: "ExactIn", slippageBps: 100, priceImpactPct: "0", routePlan: [] }
const FEE = 502_512
// The nth blockhash the stand-in RPC hands out; rows name it "read n".
const HASHES = Array.from({ length: 8 }, () => key().toBase58())
const hashOf = (n: number) => HASHES[n - 1]!
const FEE_FREE_TX = priorityFeeTx()

type Instr = { programId: string; accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; data: string }
/** A SOL -> USDC ExactIn swap-instructions answer, in the shape Jupiter returns it, routed through one table. */
function instructions(swapAccounts?: string[]): Record<string, unknown> {
  const swap: Instr = {
    programId: JUPITER_PROGRAM,
    accounts: [
      { pubkey: PAYER, isSigner: true, isWritable: false },
      { pubkey: WSOL_ATA, isSigner: false, isWritable: true },
      ...(swapAccounts ?? [USDC_MINT]).map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: "AQIDBA==",
  }
  return {
    tokenLedgerInstruction: null,
    computeBudgetInstructions: [
      { programId: COMPUTE_BUDGET, accounts: [], data: "AsBcFQA=" },
      { programId: COMPUTE_BUDGET, accounts: [], data: "AwQXAQAAAAAA" },
    ],
    setupInstructions: [
      { programId: ATA_PROGRAM, accounts: [PAYER, WSOL_ATA, PAYER, WSOL_MINT, SYSTEM, TOKEN_PROGRAM].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i < 2 })), data: "AQ==" },
      { programId: SYSTEM, accounts: [{ pubkey: PAYER, isSigner: true, isWritable: true }, { pubkey: WSOL_ATA, isSigner: false, isWritable: true }], data: "AgAAAADh9QUAAAAA" },
      { programId: TOKEN_PROGRAM, accounts: [{ pubkey: WSOL_ATA, isSigner: false, isWritable: true }], data: "EQ==" },
    ],
    swapInstruction: swap,
    cleanupInstruction: { programId: TOKEN_PROGRAM, accounts: [{ pubkey: WSOL_ATA, isSigner: false, isWritable: true }, { pubkey: PAYER, isSigner: false, isWritable: true }, { pubkey: PAYER, isSigner: true, isWritable: false }], data: "CQ==" },
    addressLookupTableAddresses: [TABLE.toBase58()],
  }
}
const table = (address: InstanceType<typeof PublicKey>, entries: InstanceType<typeof PublicKey>[]) =>
  new AddressLookupTableAccount({ key: address, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: entries } })

type Read = { n: number; rpc: string; table?: "route" | "other" }
type Row = { id: string; scenario: string; args: Record<string, unknown>; reads?: Read[]; jupiter?: string[]; outcome: Record<string, unknown> }
const rows: Row[] = []

type Script = {
  /** Answers each table read in order; past the end, the last answer repeats. `null` is a table the RPC can't read. */
  tables?: Array<InstanceType<typeof PublicKey>[] | null | "throw">
  /** Answers each blockhash read in order; "throw" is an RPC failure. */
  hashes?: Array<"ok" | "throw">
  /** Holds every blockhash read until released. */
  holdHash?: Promise<void>
}
/** A connection that answers only what the composer reads, recording each read in the order it reached the wire. */
function connection(script: Script = {}) {
  const reads: Read[] = []
  let tableReads = 0
  let hashReads = 0
  const conn = {
    getAddressLookupTable: async (address: InstanceType<typeof PublicKey>) => {
      const which = address.equals(TABLE) ? "route" : address.equals(OTHER_TABLE) ? "other" : undefined
      reads.push({ n: reads.length + 1, rpc: "getAddressLookupTable", ...(which ? { table: which } : {}) })
      if (!which) return { context: { slot: 1 }, value: null }
      const answers = script.tables ?? [[new PublicKey(USDC_MINT)]]
      const answer = answers[Math.min(tableReads++, answers.length - 1)]
      if (answer === "throw") throw new Error("stand-in RPC refused the read")
      return { context: { slot: 1 }, value: answer === null ? null : table(address, answer!) }
    },
    getLatestBlockhash: async () => {
      reads.push({ n: reads.length + 1, rpc: "getLatestBlockhash" })
      const n = ++hashReads
      const answers = script.hashes ?? ["ok"]
      const answer = answers[Math.min(n - 1, answers.length - 1)]
      if (script.holdHash) await script.holdHash
      if (answer === "throw") throw new Error("stand-in RPC refused the read")
      return { blockhash: hashOf(n), lastValidBlockHeight: 1_000 + n }
    },
    simulateTransaction: async () => {
      reads.push({ n: reads.length + 1, rpc: "simulateTransaction" })
      return { context: { slot: 1 }, value: { err: null } }
    },
  }
  return { conn, reads, count: (rpc: string) => reads.filter((r) => r.rpc === rpc).length }
}

/** Jupiter, answered here: swap-instructions from `answer`, and its own fee-free /swap with a finished transaction. */
function jupiter(answer: () => Record<string, unknown>) {
  const paths: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    paths.push(url.pathname)
    if (url.pathname === "/swap/v1/swap-instructions") return Response.json(answer())
    if (url.pathname === "/swap/v1/swap") return Response.json({ swapTransaction: FEE_FREE_TX, lastValidBlockHeight: 77 })
    throw new Error(`build-cache recording may not access the network (${url.host}${url.pathname})`)
  }) as typeof fetch
  return paths
}

/** One web buy, called the way POST /jupiter/swap's buildBuy calls it: the process's connection, no priority cap. */
async function webBuy(conn: unknown) {
  const built = await getSwapTransactionWithInputFee(conn, PAYER, QUOTE, FEE, FEE_COLLECTOR, () => { throw new Error("a SOL-input fee never needs the rent payer") })
  const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"))
  const hashN = HASHES.map((_, i) => i + 1).find((n) => hashOf(n) === tx.message.recentBlockhash)
  return {
    feeForgone: built.feeForgone as boolean,
    ...(built.feeForgoneReason ? { feeForgoneReason: built.feeForgoneReason as string } : {}),
    feeCarried: tx.message.staticAccountKeys.some((k: InstanceType<typeof PublicKey>) => k.equals(FEE_COLLECTOR)),
    tablesUsed: tx.message.addressTableLookups.length,
    hash: hashN === undefined ? (built.swapTransaction === FEE_FREE_TX ? "jupiter's own" : "other") : `read ${hashN}`,
    lastValidBlockHeight: built.lastValidBlockHeight as number,
  }
}
const at = (ms: number) => { clock = 1_790_000_000_000 + ms }

// 1. The warm blockhash.
{
  const boundary = async (id: string, gapMs: number) => {
    at(0)
    const c = connection()
    const first = await freshLatestBlockhash(c.conn)
    at(gapMs)
    const second = await freshLatestBlockhash(c.conn)
    rows.push({ id, scenario: "blockhash", args: { gapMs }, reads: c.reads, outcome: { fetches: c.count("getLatestBlockhash"), sameHash: first.blockhash === second.blockhash, heightIsTheRpcs: second.lastValidBlockHeight === 1_000 + c.count("getLatestBlockhash") } })
  }
  await boundary("blockhash-reused-inside-the-window", 1_499)
  await boundary("blockhash-read-again-at-the-window", 1_500)
  assert.equal(rows.at(-2)!.outcome.fetches, 1)
  assert.equal(rows.at(-1)!.outcome.fetches, 2)

  at(0)
  let release!: () => void
  const held = connection({ holdHash: new Promise<void>((r) => { release = r }) })
  const burst = Array.from({ length: 5 }, () => freshLatestBlockhash(held.conn))
  await new Promise((r) => setTimeout(r, 5))
  const onWire = held.count("getLatestBlockhash")
  release()
  const answers = await Promise.all(burst)
  assert.equal(onWire, 1)
  rows.push({ id: "blockhash-burst-shares-one-read", scenario: "blockhash", args: { callers: 5 }, reads: held.reads, outcome: { fetches: held.count("getLatestBlockhash"), sameHash: new Set(answers.map((a) => a.blockhash)).size === 1 } })

  at(0)
  const failing = connection({ hashes: ["throw", "ok"] })
  const firstFailed = await freshLatestBlockhash(failing.conn).then(() => false, () => true)
  const retried = await freshLatestBlockhash(failing.conn)
  assert.ok(firstFailed)
  rows.push({ id: "blockhash-failed-read-is-not-kept", scenario: "blockhash", args: { first: "rpc failure" }, reads: failing.reads, outcome: { firstRejected: firstFailed, fetches: failing.count("getLatestBlockhash"), secondIsTheRpcs: retried.blockhash === hashOf(2) } })

  at(0)
  const expired = connection({ hashes: ["ok", "throw"] })
  await freshLatestBlockhash(expired.conn)
  at(1_500)
  const staleServed = await freshLatestBlockhash(expired.conn).then(() => true, () => false)
  assert.equal(staleServed, false)
  rows.push({ id: "blockhash-expired-is-never-served-on-failure", scenario: "blockhash", args: { gapMs: 1_500, second: "rpc failure" }, reads: expired.reads, outcome: { secondRejected: !staleServed, fetches: expired.count("getLatestBlockhash") } })

  at(0)
  const a = connection()
  const b = connection()
  await freshLatestBlockhash(a.conn)
  await freshLatestBlockhash(b.conn)
  rows.push({ id: "blockhash-per-connection", scenario: "blockhash", args: { connections: 2 }, outcome: { fetches: a.count("getLatestBlockhash") + b.count("getLatestBlockhash") } })
}

// 2. The lookup tables.
{
  const route = TABLE.toBase58()
  const other = OTHER_TABLE.toBase58()
  const boundary = async (id: string, gapMs: number) => {
    at(0)
    const c = connection()
    await cachedAddressLookupTable(c.conn, route)
    at(gapMs)
    await cachedAddressLookupTable(c.conn, route)
    rows.push({ id, scenario: "lookup-table", args: { gapMs }, reads: c.reads, outcome: { fetches: c.count("getAddressLookupTable") } })
  }
  await boundary("table-reused-inside-the-window", 9_999)
  await boundary("table-read-again-at-the-window", 10_000)
  assert.equal(rows.at(-2)!.outcome.fetches, 1)
  assert.equal(rows.at(-1)!.outcome.fetches, 2)

  at(0)
  const missing = connection({ tables: [null, [new PublicKey(USDC_MINT)]] })
  const first = await cachedAddressLookupTable(missing.conn, route)
  const second = await cachedAddressLookupTable(missing.conn, route)
  rows.push({ id: "table-unreadable-is-not-kept", scenario: "lookup-table", args: { first: "not found" }, reads: missing.reads, outcome: { firstFound: first !== null, secondFound: second !== null, fetches: missing.count("getAddressLookupTable") } })

  at(0)
  const failing = connection({ tables: ["throw", [new PublicKey(USDC_MINT)]] })
  const rejected = await cachedAddressLookupTable(failing.conn, route).then(() => false, () => true)
  const after = await cachedAddressLookupTable(failing.conn, route)
  rows.push({ id: "table-failed-read-is-not-kept", scenario: "lookup-table", args: { first: "rpc failure" }, reads: failing.reads, outcome: { firstRejected: rejected, secondFound: after !== null, fetches: failing.count("getAddressLookupTable") } })

  at(0)
  const two = connection()
  for (const address of [route, other, route, other]) await cachedAddressLookupTable(two.conn, address)
  rows.push({ id: "table-per-address", scenario: "lookup-table", args: { addresses: 2, readsEach: 2 }, reads: two.reads, outcome: { fetches: two.count("getAddressLookupTable") } })

  at(0)
  const dropped = connection()
  await cachedAddressLookupTable(dropped.conn, route)
  await cachedAddressLookupTable(dropped.conn, other)
  forgetAddressLookupTables(dropped.conn, [route])
  await cachedAddressLookupTable(dropped.conn, route)
  await cachedAddressLookupTable(dropped.conn, other)
  rows.push({ id: "table-dropped-is-read-again-and-only-it", scenario: "lookup-table", args: { dropped: "route" }, reads: dropped.reads, outcome: { fetches: dropped.count("getAddressLookupTable"), readAgain: dropped.reads.slice(2).map((r) => r.table) } })

  at(0)
  const a = connection()
  const b = connection()
  await cachedAddressLookupTable(a.conn, route)
  await cachedAddressLookupTable(b.conn, route)
  rows.push({ id: "table-per-connection", scenario: "lookup-table", args: { connections: 2 }, outcome: { fetches: a.count("getAddressLookupTable") + b.count("getAddressLookupTable") } })
}

// 3. The web's buy, through the composer POST /jupiter/swap calls.
{
  const pair = async (id: string, gapMs: number) => {
    at(0)
    const c = connection()
    const paths = jupiter(() => instructions())
    const first = await webBuy(c.conn)
    at(gapMs)
    const second = await webBuy(c.conn)
    rows.push({ id, scenario: "web-buy", args: { buys: 2, gapMs }, reads: c.reads, jupiter: paths, outcome: { tableReads: c.count("getAddressLookupTable"), hashReads: c.count("getLatestBlockhash"), simulations: c.count("simulateTransaction"), first, second } })
    return { first, second, c }
  }
  const quick = await pair("web-buy-second-reads-neither", 1_000)
  assert.equal(quick.c.count("getAddressLookupTable"), 1)
  assert.equal(quick.c.count("getLatestBlockhash"), 1)
  assert.deepEqual([quick.first.feeCarried, quick.second.feeCarried, quick.first.feeForgone, quick.second.feeForgone], [true, true, false, false])
  assert.equal(quick.second.hash, "read 1")
  const later = await pair("web-buy-past-the-hash-window-reads-the-hash", 1_500)
  assert.deepEqual([later.c.count("getAddressLookupTable"), later.c.count("getLatestBlockhash"), later.second.hash], [1, 2, "read 2"])
  const latest = await pair("web-buy-past-the-table-window-reads-both", 10_000)
  assert.deepEqual([latest.c.count("getAddressLookupTable"), latest.c.count("getLatestBlockhash")], [2, 2])

  // An agent build on the same connection warms the web's buy: one cache per connection, whoever reads it first.
  at(0)
  const shared = connection()
  const paths = jupiter(() => instructions())
  await getSwapTransactionWithInputFee(shared.conn, PAYER, QUOTE, FEE, FEE_COLLECTOR, () => { throw new Error("unused") }, 100_000)
  const web = await webBuy(shared.conn)
  assert.deepEqual([shared.count("getAddressLookupTable"), shared.count("getLatestBlockhash")], [1, 1])
  rows.push({ id: "web-buy-after-an-agent-build-reads-neither", scenario: "web-buy", args: { first: "agent build", then: "web buy", gapMs: 0 }, reads: shared.reads, jupiter: paths, outcome: { tableReads: 1, hashReads: 1, web } })

  // Three buys at once: the hash is one read; the table cache has no shared read, so each buy reads it.
  at(0)
  const burst = connection()
  const burstPaths = jupiter(() => instructions())
  const three = await Promise.all([webBuy(burst.conn), webBuy(burst.conn), webBuy(burst.conn)])
  assert.equal(burst.count("getLatestBlockhash"), 1)
  rows.push({ id: "web-buy-burst-shares-the-hash", scenario: "web-buy", args: { buys: 3, together: true }, reads: burst.reads, jupiter: burstPaths, outcome: { hashReads: burst.count("getLatestBlockhash"), tableReads: burst.count("getAddressLookupTable"), feeCarried: three.every((b) => b.feeCarried), sameHash: new Set(three.map((b) => b.hash)).size === 1 } })

  // A table the RPC couldn't read: the buy composes without it, and the next buy reads it again.
  at(0)
  const missing = connection({ tables: [null, [new PublicKey(USDC_MINT)]] })
  const missingPaths = jupiter(() => instructions())
  const without = await webBuy(missing.conn)
  const withTable = await webBuy(missing.conn)
  assert.deepEqual([without.tablesUsed, withTable.tablesUsed, missing.count("getAddressLookupTable")], [0, 1, 2])
  rows.push({ id: "web-buy-unreadable-table-is-read-next-buy", scenario: "web-buy", args: { buys: 2, firstTable: "not found" }, reads: missing.reads, jupiter: missingPaths, outcome: { tableReads: 2, first: without, second: withTable } })

  // The hash read fails: the buy fails with nothing to sign, and the next buy reads again.
  at(0)
  const failing = connection({ hashes: ["throw", "ok"] })
  const failPaths = jupiter(() => instructions())
  const failed = await webBuy(failing.conn).then(() => false, () => true)
  const next = await webBuy(failing.conn)
  assert.ok(failed)
  rows.push({ id: "web-buy-failed-hash-read-builds-nothing", scenario: "web-buy", args: { buys: 2, firstHash: "rpc failure" }, reads: failing.reads, jupiter: failPaths, outcome: { firstRejected: failed, simulatedBeforeTheRetry: failing.reads.slice(0, failing.reads.findLastIndex((r) => r.rpc === "getLatestBlockhash")).some((r) => r.rpc === "simulateTransaction"), hashReads: failing.count("getLatestBlockhash"), second: next } })

  // A cached table that grew on chain: the route's new accounts aren't in the cached copy, the message overflows,
  // and the composer reads the tables again once before it gives the fee up.
  const appended = Array.from({ length: 39 }, () => key())
  const grownAnswer = () => instructions(appended.map((k) => k.toBase58()))
  at(0)
  const grown = connection({ tables: [[new PublicKey(USDC_MINT)], appended] })
  const grownPaths = jupiter(grownAnswer)
  const kept = await webBuy(grown.conn)
  assert.deepEqual([grown.count("getAddressLookupTable"), kept.feeForgone, grownPaths.filter((p) => p === "/swap/v1/swap").length], [2, false, 0])
  rows.push({ id: "web-buy-stale-table-is-read-again-and-the-fee-kept", scenario: "stale-table", args: { cachedTable: "before the append", routeAccounts: 39 }, reads: grown.reads, jupiter: grownPaths, outcome: { tableReads: 2, feeFreeRequests: 0, buy: kept } })

  at(0)
  const never = connection({ tables: [[new PublicKey(USDC_MINT)]] })
  const neverPaths = jupiter(grownAnswer)
  const forgone = await webBuy(never.conn)
  assert.deepEqual([never.count("getAddressLookupTable"), forgone.feeForgone, neverPaths.filter((p) => p === "/swap/v1/swap").length], [2, true, 1])
  rows.push({ id: "web-buy-still-too-big-after-one-read-falls-back-as-before", scenario: "stale-table", args: { table: "never grows", routeAccounts: 39 }, reads: never.reads, jupiter: neverPaths, outcome: { tableReads: 2, feeFreeRequests: 1, buy: forgone } })
}

// 4. Source facts at the pinned commit: the route handlers, which have no process to run here.
const swap = text(FILES[1]!)
const web = text(FILES[2]!)
const client = text(FILES[3]!)
const agent = text(FILES[4]!)
const dflow = text(FILES[5]!)
const pin = (id: string, file: string, found: boolean) => {
  assert.ok(found, `${id} (${file})`)
  rows.push({ id, scenario: "source-pin", args: { file }, outcome: { found } })
}
const before = (haystack: string, first: RegExp, then: RegExp) => {
  const a = haystack.search(first)
  const b = haystack.search(then)
  return a >= 0 && b >= 0 && a < b
}
pin("web-buy-uses-the-process-connection", FILES[2]!, /builders\.getSwapTransactionWithInputFee\(\s*builders\.getConnection\(\),/.test(web))
pin("web-buy-passes-no-priority-cap", FILES[2]!, /getFeeCollectorOwner\(\),\s*builders\.getRentPayerKeypair,\s*\)/.test(web))
pin("web-swap-is-session-auth", FILES[2]!, /jupiterRoutes\.post\("\/swap", requireAuth, /.test(web))
pin("one-connection-per-process", FILES[3]!, /if \(!connectionInstance\) \{/.test(client))
pin("tables-read-through-the-cache", FILES[1]!, /return cachedAddressLookupTable\(connection, address\)/.test(swap))
pin("hash-read-through-the-cache", FILES[1]!, /timeSpan\("bhash", \(\) => freshLatestBlockhash\(connection\)\)/.test(swap))
pin("compile-failure-reads-tables-once-more", FILES[1]!, /catch \(err\) \{[\s\S]{0,600}?await refetchTables\(\)\s*built = compileAndSerialize\(\)/.test(swap))
pin("overflow-reads-tables-once-before-the-fee-goes", FILES[1]!, /if \(!tablesFresh && \(!built\.serialized \|\| built\.serialized\.length > PACKET_DATA_SIZE\)\) \{\s*await refetchTables\(\)/.test(swap))
pin("build-breaker-and-payer-start-together", FILES[4]!, /const routeFailRead =[\s\S]{0,900}?startRead\([\s\S]{0,900}?const payerRead =[\s\S]{0,700}?startRead\([\s\S]{0,700}?if \(routeFailRead !== null\) \{\s*const routeFail[^=]*= await routeFailRead/.test(agent))
pin("build-breaker-answers-before-the-payer-is-used", FILES[4]!, before(agent, /"SWAP_ROUTE_FAILING",\s*`Key /, /const resolved = await payerRead/))
pin("build-payer-read-only-for-a-linked-payer", FILES[4]!, /const payerRead =\s*payer\.type !== "main"/.test(agent))
pin("build-feed-read-starts-early", FILES[4]!, before(agent, /startRead\(readFeedRow\(mint\)/, /await feedMetaRead/))
pin("build-mount-reads-wallets-fresh", FILES[4]!, /tradeAgent\.post\("\/build", hideEcho, timedStage\("mw", requireAgentKey\("swap:write"\)\), /.test(agent))
pin("dflow-quote-budget-is-400ms", FILES[5]!, /export const DFLOW_QUOTE_BUDGET_MS = 400\b/.test(dflow))

// The codes the build's checks answer with before any swap is built, in the order the handler can reach them.
{
  const handler = agent.slice(agent.indexOf("const routeFailRead ="), agent.indexOf("const resolved = await payerRead") + 400)
  // A refusal guarded by `preview &&` belongs to /trade/agent/preview, a Hood-only route this build never takes.
  // The guard is on the refusal's own line or on the `if` line just above it.
  const line = (at: number) => handler.slice(handler.lastIndexOf("\n", handler.lastIndexOf("\n", at) - 1) + 1, at)
  const found = [...handler.matchAll(/fail\(\s*c,\s*"([A-Z_]+)"/g)]
  const codes = [...new Set(found.filter((m) => !/\bpreview &&/.test(line(m.index!))).map((m) => m[1]!))]
  const previewOnly = [...new Set(found.filter((m) => /\bpreview &&/.test(line(m.index!))).map((m) => m[1]!))]
  rows.push({ id: "build-check-codes", scenario: "codes", args: { file: FILES[4]! }, outcome: { codes, previewOnly } })
}

Date.now = realNow
console.warn = originalWarn
const textOut = JSON.stringify(rows)
for (const secret of [...HASHES, PAYER, WSOL_ATA, TABLE.toBase58(), OTHER_TABLE.toBase58(), FEE_COLLECTOR.toBase58(), FEE_FREE_TX, "BEGIN"]) assert.ok(!textOut.includes(secret), `a fixture carries ${secret.slice(0, 8)}`)
writeFileSync(join(import.meta.dir, "../test/fixtures/candle-build-cache-source.json"), `${JSON.stringify({
  about: "Offline build-path contracts (BE-3920): the warm blockhash (1.5 s, one shared read, a failure never kept), the cached lookup tables (10 s, per address and connection, an unreadable table never kept), and the web's buy as POST /jupiter/swap builds it, reading neither inside the windows, keeping the fee exactly as before and reading a stale table again once before it gives the fee up. Recorded by running the API's own source against a stand-in connection and Jupiter from an exact staging commit; every fetch and RPC is intercepted. The build handler's parallel checks and the web route's wiring are pinned as source text. The commit changes no CLI, MCP or SDK file: their published versions are the ones named in the source block.",
  source, rows,
}, null, 2)}\n`)
console.log(`Recorded ${rows.length} offline build-path contracts from ${source.commit}.`)
