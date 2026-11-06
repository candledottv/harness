// Turns the recorder's raw output into committed fixtures.
// The raw folder holds a real (throwaway) account's addresses, ids, labels and figures; this writes
// made-up ones in their place and refuses to write anything it doesn't recognise.
//
//   bun scripts/scrub-recordings.ts <raw recordings folder> <out folder> [--tools test/fixtures/candle-tools.json]
//
// A handshake's tools/list is the same for every key, so the handshake files keep only the names, and
// --tools writes the first full list (descriptions and schemas) as the fake server's tool fixture.
//
// What changes:
//   - every address: the embedded Solana and EVM wallets, TEE wallets, and the paper-bought mint
//     (to the fake MOON); the public base mints (SOL, USDC) stay;
//   - client ids to fixed UUIDs, key prefixes, the username, and TEE ids and labels to fakes;
//   - balances, prices, market figures, timestamps and the tx limit to round made-up numbers;
//   - the server's start-up banner (it names the account and API host);
//   - key labels in file names (first, second, spare1) to agent-a, agent-b, agent-denied.
//   - each key prefix to its own fake, in fields and in messages; token mints
//     to fakes (with their symbol and name); the vault's address, Candle's fee treasury, Privy's ids, the
//     profile id, the home folder and the API host; amounts and clocks by field;
//   - `clicmd-*` files are the CLI's own answers (`{ command, exit, stdout }`), scrubbed the same way;
//   - the vault's entries (a TEE wallet's by its `role`, each vault key, their
//     ids and labels), a linked TEE row (`walletKind: "tee"`, its `_id`), the vault's factor ids and
//     labels, and the device token's prefix, each to its own fake.
//   - close-empty's token accounts, transaction signatures, staking withdrawal
//     accounts, a close's or rename's TEE wallet (`wallet` beside `linkedWalletId`, a `renamed` row and
//     its old label), and key rows (`_id`, a label beside a `keyPrefix`). A close's lamports stay, so
//     its figures still add up with the preview's words.
// What stays: shapes, field names, codes, messages, tool descriptions and timings.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const PUBLIC_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // SOL (docs.candle.tv/developers/networks-and-contracts)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "11111111111111111111111111111111", // the system program
  "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL", // CNDL
  "LuPsFmtvdFMuCjd6GBMVUErTiBAkkP6ECUVjsPcCNDL", // sCNDL, Candle's staked CNDL
])
export const FAKE = {
  wallet: "WalletFake111111111111111111111111111111111",
  evm: "0x00000000000000000000000000000000000Fa4e1",
  tee: (n: number) => `TeeFake${n}`.padEnd(43, "1"),
  mint: "MoonFake11111111111111111111111111111111111",
  uuid: (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  username: "fake-agent",
  teeId: (n: number) => `teefakeid${n}`,
  teeLabel: (n: number) => `tee-wallet-${n}`,
  keyPrefix: (n: number) => `FakeKey${n}`,
  devicePrefix: (n: number) => `FakeDvc${n}`,
  vaultKey: (n: number) => `VaultKeyFake${n}`.padEnd(43, "1"),
  vaultKeyLabel: (n: number) => `vault-key-${n}`,
  token: (n: number) => `TokenFake${n}`.padEnd(43, "z"),
  vault: "VaultFake11111111111111111111111111111111111",
  treasury: "TreasuryFake1111111111111111111111111111111",
  opaque: (field: string, n: number) => `fake-${field}-${n}`,
  home: "~",
  tokenAccount: (n: number) => `TokenAcctFake${n}`.padEnd(43, "1"),
  signature: (n: number) => `SigFake${n}`.padEnd(88, "1"),
  withdrawal: (n: number) => `WithdrawalFake${n}`.padEnd(43, "1"),
  apiUrl: "https://api.candle.example",
} as const

/** Raw key labels as the recorder was given them, and what the fixtures call them. */
export const LABELS: Record<string, string> = { first: "agent-a", second: "agent-b", spare1: "agent-denied", a: "agent-a", b: "agent-b" }

/** Numeric fields replaced wherever they appear, by name: the account's figures and clocks. */
const NUMBERS: Record<string, (path: string[]) => unknown> = {
  priceUsd: (p) => (p.includes("hood:native") ? 3000 : 150),
  marketCap: () => 1_000_000_000,
  liquidityUsd: () => 10_000_000,
  organicScore: () => 99,
  checkedAt: () => 1_790_000_000_000,
  maxTierExpiresAt: () => 1_792_000_000_000,
  stakedCndl: () => 0,
  heldCndl: () => 0,
  usdMicros: () => 100_000_000,
  // The paper buy of 0.01 SOL, valued at the fake prices (SOL 150, MOON 0.63).
  tokenAmount: () => 2.380952,
  accountValueUsd: () => "0",
  unrealizedPnlUsd: () => "0",
  count: (p) => (p.includes("feeTotals") ? 1 : undefined),
  // A key's Candle cap and the day's use: the cap as usdMicros above, the use made up.
  capUsdMicros: () => 100_000_000,
  nextWindowCapUsdMicros: () => 100_000_000,
  todayUsdMicros: () => 4_000_000,
  monthUsdMicros: () => 4_000_000,
  reservedUsdMicros: () => 4_000_000,
  remainingUsdMicros: () => 96_000_000,
  weekUsdMicros: () => 20_000_000,
  lifetimeUsdMicros: () => 20_000_000,
  days30UsdMicros: () => 20_000_000,
}
/** Clock fields not named above (`assignedAt`, `createdAt`, `_creationTime`, …): one fixed time. */
const CLOCK = /(At|_creationTime|Time)$/
const STRINGS: Record<string, (path: string[], value: string) => unknown> = {
  // A balance; a closed token account's rent (under `closed`, `accounts`, `transactions`) stays, so a close adds up.
  lamports: (p) => (p.some((k) => k === "closed" || k === "accounts" || k === "transactions") ? undefined : "1000000000"),
  amountRaw: (_, v) => (v === "0" ? "0" : "1000000"),
  feeRawSum: () => "100000",
  windowKey: (_, v) => v.replace(/\d{13}/, "1790000000000"),
  pendingWithdrawalRaw: (_, v) => (v === "0" ? "0" : "1000000"),
  wei: () => "0",
  expectedOutRaw: () => "2380952",
  label: (p) => (p.includes("envelopes") ? "factor-label" : "wallet-label"),
  stderrTail: () => "Starting the Candle MCP server\n", // only a non-empty one is replaced (replaceFields)
}

const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
/** A Solana transaction signature: 64 bytes, 86 to 88 characters. */
const SIGNATURE = /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g
const HEX_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
/** Fields holding a key's 8-character prefix. */
const PREFIX_FIELDS = new Set(["keyPrefix", "boundKeyPrefix", "fromKeyPrefix", "prefix"])
/** Opaque account ids from Privy and Candle, each replaced by its own fake. */
const OPAQUE_FIELDS = ["profileId", "privyWalletId", "privyPolicyId", "signerQuorumId", "remoteEvidenceDigest"]
/** A key prefix named in a message ("bound to key Ab3dEf9h", "visible to key Ab3dEf9h"). */
const PREFIX_IN_TEXT = /\bkey ([A-Za-z0-9_-]{8})\b/g
const HOME = /^(\/Users\/[^/\s"]+)/
const API_HOST = /https:\/\/api\.[a-z0-9.-]*candle\.tv/g

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Learns the account's identifiers from the recordings' structure, so each gets a role-true fake. */
export function learnReplacements(files: Record<string, Json>): Map<string, string> {
  const map = new Map<string, string>()
  let tees = 0
  let prefixes = 0
  let tokens = 0
  const opaque: Record<string, number> = {}
  const prefix = (p: string) => {
    if (!map.has(p)) map.set(p, FAKE.keyPrefix(++prefixes))
  }
  let devices = 0
  let vaultKeys = 0
  let tokenAccounts = 0
  let signatures = 0
  let withdrawals = 0
  const signature = (s: Json | undefined) => {
    if (typeof s === "string" && !map.has(s)) map.set(s, FAKE.signature(++signatures))
  }
  /** A TEE wallet seen anywhere: one fake for its address, and its id and label to match. */
  const teeWallet = (address: string, id?: Json, label?: Json) => {
    if (!map.has(address)) map.set(address, FAKE.tee(++tees))
    // The fake is padded with 1s, so its number is found by matching, not read off its digits.
    let n = 1
    while (n < tees && FAKE.tee(n) !== map.get(address)) n += 1
    if (typeof id === "string" && !map.has(id)) map.set(id, FAKE.teeId(n))
    if (typeof label === "string" && !map.has(label)) map.set(label, FAKE.teeLabel(n))
  }
  const token = (mint: string, price?: Record<string, Json>) => {
    if (PUBLIC_MINTS.has(mint)) return
    if (!map.has(mint)) map.set(mint, FAKE.token(++tokens))
    const n = /^TokenFake(\d+)/.exec(map.get(mint)!)?.[1]
    if (!n) return // the paper-bought mint, already MOON
    if (typeof price?.symbol === "string" && !map.has(price.symbol)) map.set(price.symbol, `TOK${n}`)
    if (typeof price?.name === "string" && !map.has(price.name)) map.set(price.name, `Token ${n}`)
  }
  const walk = (value: Json, path: string[]) => {
    if (typeof value === "string") {
      for (const m of value.matchAll(PREFIX_IN_TEXT)) prefix(m[1]!)
      const home = HOME.exec(value)?.[1]
      if (home) map.set(home, FAKE.home)
      for (const host of value.match(API_HOST) ?? []) map.set(host, FAKE.apiUrl)
      return
    }
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, String(i)]))
    else if (value && typeof value === "object") {
      const o = value as Record<string, Json>
      if (path.at(-1) === "solana" && typeof o.address === "string") map.set(o.address, FAKE.wallet)
      if (path.at(-1) === "evm" && typeof o.address === "string") map.set(o.address, FAKE.evm)
      // A token account (close-empty's rows carry `tokenProgram`) is its own fake; any other `account` is the embedded wallet.
      if (typeof o.account === "string" && typeof o.tokenProgram === "string") {
        if (!map.has(o.account)) map.set(o.account, FAKE.tokenAccount(++tokenAccounts))
      } else if (typeof o.account === "string") map.set(o.account, FAKE.wallet)
      signature(o.signature)
      if (Array.isArray(o.signatures)) o.signatures.forEach(signature)
      if (typeof o.withdrawal === "string" && !map.has(o.withdrawal)) map.set(o.withdrawal, FAKE.withdrawal(++withdrawals))
      // A close's TEE wallet, and a rename's (its old label as the fake's, marked renamed).
      if (typeof o.wallet === "string" && typeof o.linkedWalletId === "string") teeWallet(o.wallet, o.linkedWalletId)
      if (path.at(-2) === "renamed" && typeof o.address === "string") {
        teeWallet(o.address, o.id, o.to)
        if (typeof o.from === "string" && !map.has(o.from)) map.set(o.from, `${map.get(o.to as string) ?? "tee-wallet"}-renamed`)
      }
      if (typeof o.keyPrefix === "string" && typeof o._id === "string" && !map.has(o._id)) {
        opaque.keyId = (opaque.keyId ?? 0) + 1
        map.set(o._id, FAKE.opaque("keyId", opaque.keyId))
      }
      if (typeof o.userAddress === "string") map.set(o.userAddress, FAKE.wallet)
      if (path.at(-2) === "embedded" && o.chain === "solana" && typeof o.address === "string") map.set(o.address, FAKE.wallet)
      if (typeof o.username === "string") map.set(o.username, FAKE.username)
      if (path.includes("tee") && typeof o.address === "string" && !map.has(o.address)) {
        tees += 1
        map.set(o.address, FAKE.tee(tees))
        if (typeof o.id === "string") map.set(o.id, FAKE.teeId(tees))
        if (typeof o.label === "string") map.set(o.label, FAKE.teeLabel(tees))
      }
      // The CLI's own TEE rows: a linked wallet in `wallets`, an entry in the vault.
      if ((o.walletKind === "tee" || o.role === "tee-wallet") && typeof o.address === "string") teeWallet(o.address, o._id, o.label)
      if (o.role === "vault" && typeof o.address === "string") {
        // The pinned vault (a TEE row's `vaultDestination`) is already FAKE.vault; any other vault key gets its own fake.
        if (!map.has(o.address)) map.set(o.address, [...map.values()].includes(FAKE.vault) ? FAKE.vaultKey(vaultKeys + 1) : FAKE.vault)
        if (typeof o.label === "string" && !map.has(o.label)) map.set(o.label, FAKE.vaultKeyLabel(++vaultKeys))
      }
      if (typeof o.role === "string" && typeof o.id === "string" && !map.has(o.id)) {
        opaque.vaultEntryId = (opaque.vaultEntryId ?? 0) + 1
        map.set(o.id, FAKE.opaque("vaultEntryId", opaque.vaultEntryId))
      }
      if (path.at(-2) === "envelopes" && typeof o.id === "string" && !map.has(o.id)) {
        opaque.envelopeId = (opaque.envelopeId ?? 0) + 1
        map.set(o.id, FAKE.opaque("envelopeId", opaque.envelopeId))
      }
      if (typeof o.deviceTokenPrefix === "string" && !map.has(o.deviceTokenPrefix)) map.set(o.deviceTokenPrefix, FAKE.devicePrefix(++devices))
      if (o.tool === "candle_trade" && o.args && typeof (o.args as Record<string, Json>).mint === "string") {
        const mint = (o.args as Record<string, Json>).mint as string
        if (!PUBLIC_MINTS.has(mint)) map.set(mint, FAKE.mint)
      }
      for (const [k, v] of Object.entries(o)) {
        if (typeof v !== "string") continue
        if (PREFIX_FIELDS.has(k) && /^[A-Za-z0-9_-]{8}$/.test(v)) prefix(v)
        if (k === "mint") token(v)
        if (k === "vaultDestination") map.set(v, FAKE.vault)
        if (k === "treasury") map.set(v, FAKE.treasury)
        if (OPAQUE_FIELDS.includes(k) && !map.has(v)) {
          opaque[k] = (opaque[k] ?? 0) + 1
          map.set(v, FAKE.opaque(k, opaque[k]!))
        }
      }
      if (path.at(-1) === "prices") for (const [mint, price] of Object.entries(o)) token(mint, price as Record<string, Json>)
      for (const [k, v] of Object.entries(o)) walk(v, [...path, k])
    }
  }
  for (const value of Object.values(files)) walk(value, [])
  let uuids = 0
  for (const value of Object.values(files)) {
    for (const id of JSON.stringify(value).match(UUID) ?? []) if (!map.has(id)) map.set(id, FAKE.uuid(++uuids))
  }
  return map
}

function replaceStrings(text: string, map: Map<string, string>): string {
  // Longest first, so no identifier is half-replaced by a shorter one inside it.
  for (const [from, to] of [...map].sort((a, b) => b[0].length - a[0].length)) text = text.split(from).join(to)
  return text
}

function replaceFields(value: Json, path: string[] = []): Json {
  if (Array.isArray(value)) return value.map((v, i) => replaceFields(v, [...path, String(i)]))
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value)) {
      const here = [...path, k]
      const number = typeof v === "number" && NUMBERS[k] ? NUMBERS[k](here) : undefined
      if (number !== undefined) out[k] = number as Json
      else if (typeof v === "number" && CLOCK.test(k) && v > 1e12) out[k] = 1_790_000_000_000
      else if (k === "label" && typeof v === "string" && typeof (value as Record<string, Json>).keyPrefix === "string") out[k] = "key-label"
      else if (typeof v === "string" && v !== "" && STRINGS[k] && STRINGS[k](here, v) !== undefined) out[k] = STRINGS[k](here, v) as Json
      else if (typeof v === "string" && CLOCK.test(k) && ISO_TIME.test(v)) out[k] = "2026-09-01T00:00:00.000Z"
      else out[k] = replaceFields(v, here)
    }
    return out
  }
  return value
}

/** Whatever still looks like the account after scrubbing: empty means safe to commit. */
export function leftovers(text: string, rawOnly: Iterable<string>): string[] {
  const found = new Set<string>()
  const fakes = new Set<string>([FAKE.wallet, FAKE.mint, FAKE.evm, FAKE.vault, FAKE.treasury])
  for (const m of text.match(BASE58) ?? []) if (!PUBLIC_MINTS.has(m) && !fakes.has(m) && !/^(TeeFake|VaultKeyFake|TokenAcctFake|WithdrawalFake)\d1+$/.test(m) && !/^TokenFake\d+z+$/.test(m) && /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m)) found.add(m)
  for (const m of text.match(SIGNATURE) ?? []) if (!/^SigFake\d+1+$/.test(m)) found.add(m)
  for (const m of text.match(HEX_ADDRESS) ?? []) if (!fakes.has(m)) found.add(m)
  for (const m of text.match(UUID) ?? []) if (!m.startsWith("00000000-0000-4000-8000-")) found.add(m)
  for (const s of rawOnly) if (s.length >= 4 && text.includes(s)) found.add(s)
  return [...found]
}

export function scrub(files: Record<string, Json>): { files: Record<string, Json>; problems: string[] } {
  const map = learnReplacements(files)
  const out: Record<string, Json> = {}
  const problems: string[] = []
  for (const [name, value] of Object.entries(files)) {
    const renamed = name.replace(/^(cli|package)-([a-z0-9_]+)-/i, (_, route: string, label: string) => `${route}-${LABELS[label] ?? label}-`)
    const scrubbed = replaceFields(JSON.parse(replaceStrings(JSON.stringify(value), map)) as Json)
    const text = JSON.stringify(scrubbed)
    for (const left of leftovers(text, map.keys())) problems.push(`${renamed}: ${left.slice(0, 6)}… is still there`)
    out[renamed] = scrubbed
  }
  return { files: out, problems }
}

/**
 * The profile and post tools. At 0.10.22 the server listed three of them only once its start-up check of
 * the key passed; at 0.10.25 (CLI 0.13.5) four, and only to a key whose public profile Candle says
 * it may edit (`registerEligibleProfileTool`, asked at start and before each tools/list). Both recorded
 * keys may, so the recording lists all four.
 */
export const LISTED_AFTER_KEY_CHECK = ["candle_update_profile", "candle_upload_profile_image", "candle_create_post", "candle_delete_post"]

/** The fake server's tool fixture, from one scrubbed handshake. */
export function toolFixture(handshake: Json, recordedOn: string): Json {
  const h = handshake as { status: { version: string }; tools: { name: string }[] }
  const marked = h.tools.filter((t) => LISTED_AFTER_KEY_CHECK.includes(t.name)).length
  return {
    about: `Candle's MCP server tools/list, recorded through \`candle mcp\` on the test machine on ${recordedOn}, scrubbed by scripts/scrub-recordings.ts. With a key that may edit its public profile all ${h.tools.length} are listed; the ${marked} marked listedAfterKeyCheck are listed only to such a key, so the fake server leaves them out unless asked.`,
    serverInfo: { name: "candle-mcp", version: h.status.version },
    tools: h.tools.map((t) => (LISTED_AFTER_KEY_CHECK.includes(t.name) ? { ...t, listedAfterKeyCheck: true } : t)),
  } as Json
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const toolsAt = args.indexOf("--tools")
  const toolsPath = toolsAt >= 0 ? args.splice(toolsAt, 2)[1] : undefined
  const [rawDir, outDir] = args
  if (!rawDir || !outDir) {
    console.error("usage: bun scripts/scrub-recordings.ts <raw recordings folder> <out folder> [--tools <path>]")
    process.exit(2)
  }
  const files: Record<string, Json> = {}
  for (const name of readdirSync(rawDir).filter((n) => n.endsWith(".json")).sort()) {
    files[name] = JSON.parse(readFileSync(join(rawDir, name), "utf8")) as Json
  }
  const { files: scrubbed, problems } = scrub(files)
  if (problems.length > 0) {
    console.error(`Not written: ${problems.length} value(s) still look like the account.\n${problems.join("\n")}`)
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true })
  const recordedOn = /\d{4}-\d{2}-\d{2}/.exec(rawDir)?.[0] ?? "an unknown date"
  let toolsWritten = false
  for (const [name, value] of Object.entries(scrubbed)) {
    let written = value
    if (name.endsWith("-handshake.json") && value && typeof value === "object" && Array.isArray((value as { tools?: unknown }).tools)) {
      const { tools, ...rest } = value as { tools: { name: string }[] }
      if (toolsPath && !toolsWritten && tools.length > 0) {
        writeFileSync(toolsPath, `${JSON.stringify(toolFixture(value, recordedOn), null, 2)}\n`)
        toolsWritten = true
      }
      written = { ...rest, toolNames: tools.map((t) => t.name) } as Json
    }
    writeFileSync(join(outDir, name), `${JSON.stringify(written, null, 2)}\n`)
  }
  console.log(`Wrote ${Object.keys(scrubbed).length} scrubbed recordings to ${outDir}`)
}
