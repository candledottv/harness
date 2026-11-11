// Where funds may go: the known list from each source, the check a
// destination meets, and "asked for", the user's own words this turn naming where and how much.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { askedFor, checkDestination, type Destination, Destinations, fromVaultList, fromWalletsRead, inGroupsOfFour, prepareFundsOut } from "./destinations"

const VAULT = "VaultFake11111111111111111111111111111111111"
const TEE = "TeeFake111111111111111111111111111111111111"
const EMBEDDED = "WalletFake111111111111111111111111111111111"
const TRUSTED = "TrustFake11111111111111111111111111111111111"
// Same first and last four as VAULT, but not it.
const LOOKALIKE = "VaultLook11111111111111111111111111111111111"
const NEW = "NewAddr2222222222222222222222222222222222222"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const recorded = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/candle-recorded/vault", name), "utf8")).stdout

const KNOWN: [Destination, Destination, Destination, Destination] = [
  { address: VAULT, label: "cold", kind: "vault-key" },
  { address: TEE, label: "tee-one", kind: "tee" },
  { address: EMBEDDED, kind: "embedded" },
  { address: TRUSTED, label: "ledger", kind: "trusted" },
]

describe("the known list", () => {
  test("from candle wallets --json, as recorded: the embedded wallet, each TEE wallet, its pinned vault; a trusted wallet by trustedAt", () => {
    const body = recorded("clicmd-wallets.json")
    const list = fromWalletsRead(body)
    expect(list).toContainEqual({ address: "WalletFake111111111111111111111111111111111", kind: "embedded" })
    expect(list).toContainEqual({ address: "0x00000000000000000000000000000000000Fa4e1", kind: "embedded" })
    expect(list).toContainEqual({ address: "TeeFake111111111111111111111111111111111111", label: "wallet-label", kind: "tee" })
    expect(list).toContainEqual({ address: "VaultFake11111111111111111111111111111111111", kind: "pinned-vault" })
    // The recording has no trusted wallet: a row with trustedAt is one; one without never is.
    expect(list.filter((d) => d.kind === "trusted")).toEqual([])
    const trusted = { ...body, linked: { ...body.linked, page: [{ address: TRUSTED, label: "ledger", walletKind: "external", trustedAt: 1790000000000, chain: "solana" }, { address: NEW, walletKind: "external", chain: "solana" }] } }
    expect(fromWalletsRead(trusted).filter((d) => d.kind === "trusted")).toEqual([{ address: TRUSTED, label: "ledger", kind: "trusted" }])
    expect(fromWalletsRead(trusted).some((d) => d.address === NEW)).toBe(false)
    expect(fromWalletsRead(undefined)).toEqual([])
  })

  test("from vault list --json, as recorded: addresses and labels only, by role", () => {
    const list = fromVaultList(recorded("clicmd-vault-list.json"))
    expect(list).toEqual([
      { address: "VaultFake11111111111111111111111111111111111", label: "wallet-label", kind: "vault-key" },
      { address: "TeeFake111111111111111111111111111111111111", label: "wallet-label", kind: "tee" },
    ])
    for (const d of list) expect(Object.keys(d).sort()).toEqual(["address", "kind", "label"])
  })

  test("the vault list is kept in state/destinations.json (0600), and read back by a new core", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dest-"))
    dirs.push(dir)
    const file = join(dir, "destinations.json")
    const one = new Destinations({ file, portfolio: () => [{ address: EMBEDDED, kind: "embedded" }] })
    await one.load()
    await one.setVaultList([{ address: VAULT, label: "cold", kind: "vault-key" }])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ vaultList: [{ address: VAULT, label: "cold", kind: "vault-key" }] })
    one.setWallets([{ address: TRUSTED, label: "ledger", kind: "trusted" }])
    const two = new Destinations({ file, portfolio: () => [] })
    await two.load()
    expect(two.all()).toEqual([{ address: VAULT, label: "cold", kind: "vault-key" }])
    // Every source together, each address once, the most specific kind kept.
    expect(one.all().map((d) => d.address).sort()).toEqual([EMBEDDED, TRUSTED, VAULT].sort())
    const dup = new Destinations({ file, portfolio: () => [{ address: VAULT, kind: "pinned-vault" }] })
    await dup.load()
    expect(dup.all()).toEqual([{ address: VAULT, label: "cold", kind: "vault-key" }])
  })
})

describe("the check", () => {
  test("a known address or label; a look-alike refused; a new address; a label nobody knows", () => {
    expect(checkDestination(VAULT, KNOWN)).toEqual({ kind: "known", destination: KNOWN[0] })
    expect(checkDestination("cold", KNOWN)).toEqual({ kind: "known", destination: KNOWN[0] })
    expect(checkDestination(LOOKALIKE, KNOWN)).toEqual({ kind: "lookalike", like: KNOWN[0] })
    expect(checkDestination(NEW, KNOWN)).toEqual({ kind: "new", address: NEW })
    expect(checkDestination("warm", KNOWN)).toEqual({ kind: "unknown-label", word: "warm" })
    // EVM addresses ignore case, so a checksum spelling of a known one is that one.
    const evm: Destination[] = [{ address: "0x00000000000000000000000000000000000Fa4e1", kind: "embedded" }]
    expect(checkDestination("0x00000000000000000000000000000000000fa4e1", evm).kind).toBe("known")
    expect(checkDestination("0x0000aaaa000000000000000000000000000Fa4e1", evm).kind).toBe("lookalike")
  })

  test("a new address is shown in full, in groups of four", () => {
    expect(inGroupsOfFour(NEW)).toBe("NewA ddr2 2222 2222 2222 2222 2222 2222 2222 2222 2222")
  })
})

describe("asked for", () => {
  const send = { destination: KNOWN[0], amount: "0.01" }
  test("the user's words this turn name the destination (label or address) and the amount", () => {
    expect(askedFor("send 0.01 SOL from tee-one to cold", send)).toEqual({ ok: true })
    expect(askedFor(`move .010 sol to ${VAULT} please`, send)).toEqual({ ok: true })
    expect(askedFor("Send 0.01 SOL to Cold", send)).toEqual({ ok: true })
  })

  test("refused: no message, the amount missing, the destination missing, another amount", () => {
    expect(askedFor(undefined, send)).toMatchObject({ ok: false, missing: "message" })
    expect(askedFor("send some SOL to cold", send)).toMatchObject({ ok: false, missing: "amount" })
    expect(askedFor("send 0.01 SOL to my vault", send)).toMatchObject({ ok: false, missing: "destination" })
    expect(askedFor("send 0.1 SOL to cold", send)).toMatchObject({ ok: false, missing: "amount" })
    // A label that's part of another word isn't it.
    expect(askedFor("send 0.01 SOL to coldstore", send)).toMatchObject({ ok: false, missing: "destination" })
  })

  test("a number in a wallet's name isn't the amount", () => {
    const hot = { address: "Hot1111111111111111111111111111111111111111", kind: "vault-key" as const, label: "hot" }
    const cold100 = { address: "Co1d100111111111111111111111111111111111111", kind: "vault-key" as const, label: "cold-100" }
    const from = { from: hot, others: [] }
    expect(askedFor("send 1 SOL from hot to cold-100", { destination: cold100, amount: "100", source: from })).toMatchObject({ ok: false, missing: "amount" })
    expect(askedFor("send 1 SOL from hot to cold-100", { destination: cold100, amount: "1", source: from })).toEqual({ ok: true })
    expect(askedFor(`send 1 SOL to ${cold100.address}`, { destination: { address: cold100.address }, amount: "100" })).toMatchObject({ ok: false, missing: "amount" })
  })

  test("a new address must be in the message in full", () => {
    const fresh = { destination: { address: NEW, kind: "new" as const }, amount: "1" }
    expect(askedFor(`send 1 SOL to ${NEW}`, fresh)).toEqual({ ok: true })
    expect(askedFor(`send 1 SOL to ${NEW.slice(0, 8)}…${NEW.slice(-4)}`, fresh)).toMatchObject({ ok: false, missing: "destination" })
  })

  test("a sweep names the wallet and says everything, all or sweep", () => {
    const sweep = { wallet: KNOWN[1], sweep: true }
    expect(askedFor("sweep tee-one home", sweep)).toEqual({ ok: true })
    expect(askedFor("move everything from tee-one to my vault", sweep)).toEqual({ ok: true })
    expect(askedFor("move tee-one's funds home", sweep)).toMatchObject({ ok: false, missing: "everything" })
    expect(askedFor("sweep everything home", sweep)).toMatchObject({ ok: false, missing: "wallet" })
  })

  test("an amount of max is asked by everything, all or max", () => {
    expect(askedFor("send all the ETH to cold", { destination: KNOWN[0], amount: "max" })).toEqual({ ok: true })
    expect(askedFor("send ETH to cold", { destination: KNOWN[0], amount: "max" })).toMatchObject({ ok: false, missing: "amount" })
  })
})

describe("a funds-out step, prepared", () => {
  const ctx = (over: Partial<Parameters<typeof prepareFundsOut>[1]> = {}): Parameters<typeof prepareFundsOut>[1] => ({ known: KNOWN, asked: "send 0.01 SOL from tee-one to cold", typed: false, valueFlags: ["--amount", "--asset", "--from", "--to", "--rpc-url", "--sweep-to"], ...over })
  const transfer = (to: string) => ["vault", "transfer", to, "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"]

  test("vault transfer to a known label goes to its address, and the card names it", () => {
    const r = prepareFundsOut(transfer("cold"), ctx())
    expect(r).toMatchObject({ ok: true, words: transfer(VAULT) })
    expect((r as { notes: string[] }).notes.join(" ")).toContain("cold, a vault key on this machine")
    expect((r as { newAddress?: string }).newAddress).toBeUndefined()
  })

  test("a look-alike is refused, naming the one it looks like; a label nobody knows is refused", () => {
    expect(prepareFundsOut(transfer(LOOKALIKE), ctx({ asked: `send 0.01 SOL to ${LOOKALIKE}` }))).toMatchObject({ ok: false, code: "LOOKALIKE_DESTINATION" })
    expect((prepareFundsOut(transfer(LOOKALIKE), ctx({ asked: `send 0.01 SOL to ${LOOKALIKE}` })) as { message: string }).message).toContain("cold")
    expect(prepareFundsOut(transfer("warm"), ctx({ asked: "send 0.01 SOL to warm" }))).toMatchObject({ ok: false, code: "UNKNOWN_DESTINATION" })
  })

  test("an address cut short or run on says so by its length, rather than as a label nobody knows", () => {
    const cut = "Mist1yped2Addr3ess4Look5ing6Real7Xy".slice(0, 30)
    const r = prepareFundsOut(transfer(cut), ctx({ asked: `send 0.01 SOL to ${cut}` })) as { ok: false; code: string; message: string }
    expect(r).toMatchObject({ ok: false, code: "MISTYPED_ADDRESS" })
    expect(r.message).toContain("is 30 characters, and a Solana address is 32 to 44: it looks cut short or run on. Copy the address again, whole.")
    const evm = `0x${"ab12".repeat(9)}`
    expect((prepareFundsOut(transfer(evm), ctx({ asked: `send 0.01 SOL to ${evm}` })) as { message: string }).message).toContain("an EVM address is 0x and 40 more")
    // A label, even a long one, is still a label nobody knows.
    expect(prepareFundsOut(transfer("mycoldwalletforsavingsonly"), ctx({ asked: "send 0.01 SOL to mycoldwalletforsavingsonly" }))).toMatchObject({ code: "UNKNOWN_DESTINATION" })
  })

  test("a new address is allowed, marked new, shown in groups of four", () => {
    const r = prepareFundsOut(transfer(NEW), ctx({ asked: `send 0.01 SOL to ${NEW}` }))
    expect(r).toMatchObject({ ok: true, words: transfer(NEW), newAddress: inGroupsOfFour(NEW) })
  })

  test("from the agent it must be asked for; typed, the line is the ask", () => {
    expect(prepareFundsOut(transfer("cold"), ctx({ asked: undefined }))).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    expect(prepareFundsOut(transfer("cold"), ctx({ asked: "send some SOL to my vault" }))).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    expect(prepareFundsOut(transfer("cold"), ctx({ asked: undefined, typed: true }))).toMatchObject({ ok: true })
    // Typed, a look-alike is still refused.
    expect(prepareFundsOut(transfer(LOOKALIKE), ctx({ asked: undefined, typed: true }))).toMatchObject({ ok: false, code: "LOOKALIKE_DESTINATION" })
  })

  test("vault transfer needs --from and --amount before anything is made", () => {
    expect(prepareFundsOut(["vault", "transfer", "cold", "--amount", "0.01", "--asset", "SOL"], ctx())).toMatchObject({ ok: false, code: "NAME_THE_SOURCE" })
    expect(prepareFundsOut(["vault", "transfer", "cold", "--asset", "SOL", "--from", "tee-one"], ctx())).toMatchObject({ ok: false, code: "NAME_THE_AMOUNT" })
  })

  test("one refusal names every flag vault transfer is missing, with the CLI's usage", () => {
    const usage = "candle vault transfer <to> --amount <n|max> --asset SOL|<mint> --from <label>"
    expect(prepareFundsOut(["vault", "transfer", "cold"], ctx())).toEqual({ ok: false, code: "NAME_THE_SOURCE", message: `Name the vault key or TEE wallet it's sent from (--from <label>), the amount (--amount <n>, or max for all of it) and the asset (--asset SOL or a mint): ${usage}. Nothing was run.` })
    expect(prepareFundsOut(["vault", "transfer", "cold", "--from", "tee-one"], ctx())).toEqual({ ok: false, code: "NAME_THE_AMOUNT", message: `Name the amount (--amount <n>, or max for all of it) and the asset (--asset SOL or a mint): ${usage}. Nothing was run.` })
    expect(prepareFundsOut(["vault", "transfer"], ctx())).toEqual({ ok: false, code: "NAME_THE_DESTINATION", message: `Name where it goes: ${usage}. Nothing was run.` })
    // max (CLI 0.13.11): the whole balance, asked for only by "everything" in the user's own words.
    const max = ["vault", "transfer", "cold", "--amount", "max", "--asset", "SOL", "--from", "tee-one"]
    expect(prepareFundsOut(max, ctx())).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    const all = prepareFundsOut(max, ctx({ asked: "send everything from tee-one to cold" })) as { ok: true; notes: string[] }
    expect(all.ok).toBe(true)
    expect(all.notes[0]).toStartWith("Sends all of its SOL from tee-one to ")
  })

  test("from the agent the asset, the source and max are the ones the message asked for", () => {
    const MINT = "MintFake11111111111111111111111111111111111"
    const HOT = "HotFake111111111111111111111111111111111111"
    const known = [...KNOWN, { address: HOT, label: "hot", kind: "vault-key" as const }]
    const send = (to: string, amount: string, asset: string, from: string) => ["vault", "transfer", to, "--amount", amount, "--asset", asset, "--from", from]
    const refused = (words: string[], asked: string) => prepareFundsOut(words, ctx({ known, asked }))
    // Another asset than the one asked for.
    expect(refused(send("cold", "10", "SOL", "hot"), "send 10 USDC to cold")).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    expect(refused(send(NEW, "1", MINT, "cold"), `send 1 SOL to ${NEW}`)).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    expect(refused(send(NEW, "0.1", MINT, "hot"), `send 0.1 SOL from cold to ${NEW}`)).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    // Another source than the one named.
    expect(refused(send(NEW, "1", "SOL", "cold"), `send 1 SOL from hot to ${NEW}`)).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    // max with an amount stated, or an "all" that isn't about the amount.
    expect(refused(send(NEW, "max", "SOL", "cold"), `send 1 SOL to ${NEW}, that's all`)).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    expect(refused(send("cold", "max", "SOL", "hot"), "send 0.1 SOL to cold once all the fills land")).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    // What a person would say still goes: SOL unsaid, a mint in full, the source named or not, everything from a wallet with a digit in its name.
    expect(refused(send("cold", "0.5", "SOL", "hot"), "send 0.5 to cold")).toMatchObject({ ok: true })
    expect(refused(send("cold", "5", MINT, "hot"), `send 5 of ${MINT} from hot to cold`)).toMatchObject({ ok: true })
    expect(refused(send("cold", "5", "usdc", "hot"), "send 5 USDC to cold")).toMatchObject({ ok: true })
    expect(refused(send(NEW, "1", "SOL", "hot"), `send 1 SOL from hot to ${NEW}`)).toMatchObject({ ok: true, newAddress: inGroupsOfFour(NEW) })
    const tee1 = [...known, { address: "Tee1Fake11111111111111111111111111111111111", label: "tee-1", kind: "tee" as const }]
    expect(prepareFundsOut(send("cold", "max", "SOL", "tee-1"), ctx({ known: tee1, asked: "send everything from tee-1 to cold" }))).toMatchObject({ ok: true })
    // vault fund: the asset (SOL when left out) and the amount on the card.
    const fund = prepareFundsOut(["vault", "fund", TEE, "--amount", "10"], ctx({ known, asked: "fund tee-one with 10 USDC" }))
    expect(fund).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    const funded = prepareFundsOut(["vault", "fund", TEE, "--amount", "10", "--asset", "USDC"], ctx({ known, asked: "fund tee-one with 10 USDC" })) as { ok: true; notes: string[] }
    expect(funded.notes[0]).toContain("with 10 USDC from your vault")
  })

  test("a message naming two assets: the amount must be the one said with this asset", () => {
    const HOT = "HotFake111111111111111111111111111111111111"
    const known = [...KNOWN, { address: HOT, label: "hot", kind: "vault-key" as const }]
    const send = (amount: string, asset: string) => prepareFundsOut(["vault", "transfer", "cold", "--amount", amount, "--asset", asset, "--from", "hot"], ctx({ known, asked: "send 10 USDC and 1 SOL to cold" }))
    expect(send("10", "SOL")).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF", message: expect.stringContaining("doesn't say this amount with this asset") })
    expect(send("1", "USDC")).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    expect(send("10", "USDC")).toMatchObject({ ok: true })
    expect(send("1", "SOL")).toMatchObject({ ok: true })
    // The asset before the number counts when none follows it, and one asset alone still goes with any amount.
    expect(askedFor("to cold: USDC 10, then SOL 1", { destination: KNOWN[0], amount: "10", asset: "SOL" })).toMatchObject({ ok: false, missing: "pairing" })
    expect(askedFor("send 10 USDC to cold", { destination: KNOWN[0], amount: "10", asset: "USDC" })).toEqual({ ok: true })
  })

  test("vault demote from the agent needs the user's words this turn naming every wallet it stops", () => {
    const TEE2 = "Tee2Fake11111111111111111111111111111111111"
    expect(prepareFundsOut(["vault", "demote", TEE], ctx({ asked: "how are my wallets doing?" }))).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF", message: expect.stringContaining("doesn't name the wallet") })
    expect(prepareFundsOut(["vault", "demote", TEE], ctx({ asked: "demote tee-one" }))).toMatchObject({ ok: true })
    expect(prepareFundsOut(["vault", "demote", "tee-one"], ctx({ asked: `retire ${TEE} for good` }))).toMatchObject({ ok: true })
    expect(prepareFundsOut(["vault", "demote", TEE, TEE2], ctx({ asked: "demote tee-one" }))).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    // Typed, the line is the ask.
    expect(prepareFundsOut(["vault", "demote", TEE, TEE2], ctx({ typed: true }))).toMatchObject({ ok: true })
  })

  test("tee sweep: a label goes by its address; still enabled, the card offers tee disable first", () => {
    const r = prepareFundsOut(["tee", "sweep", "tee-one"], ctx({ asked: "sweep tee-one home", teeEnabled: () => true, pinnedVault: () => VAULT }))
    expect(r).toMatchObject({ ok: true, words: ["tee", "sweep", TEE] })
    const ok = r as { notes: string[]; warning?: string; fills?: { label: string; line: string }[] }
    expect(ok.notes.join(" ")).toContain("cold")
    expect(ok.warning).toContain("still enabled")
    expect(ok.fills).toEqual([{ label: "disable it first", line: `candle tee disable ${TEE}` }])
    const off = prepareFundsOut(["tee", "sweep", TEE], ctx({ asked: "sweep everything from tee-one", teeEnabled: () => false }))
    expect((off as { warning?: string }).warning).toBeUndefined()
    expect(prepareFundsOut(["tee", "sweep", TEE], ctx({ asked: "send 0.01 to cold" }))).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
  })

  test("external sweep: --to goes home to a vault key, and a look-alike is refused", () => {
    expect(prepareFundsOut(["external", "sweep", "ext-1", "--to", "cold"], ctx({ asked: "sweep everything from ext-1 to cold" }))).toMatchObject({ ok: true })
    expect(prepareFundsOut(["external", "sweep", "ext-1", "--to", LOOKALIKE], ctx({ asked: `sweep all of ext-1 to ${LOOKALIKE}` }))).toMatchObject({ ok: false, code: "LOOKALIKE_DESTINATION" })
  })

  test("a TEE wallet stopped for good, or swept and retired, is never a destination, typed or by its label", () => {
    const fund = ["vault", "fund", "tee-one", "--asset", "SOL", "--amount", "0.01"]
    const gone = (state: "stopped" | "retired") => (address: string) => (address === TEE ? state : undefined)
    expect(prepareFundsOut(fund, ctx({ asked: undefined, typed: true, gone: gone("retired") }))).toMatchObject({ ok: false, code: "RETIRED_DESTINATION" })
    expect(prepareFundsOut(["vault", "fund", TEE, "--amount", "0.01"], ctx({ asked: undefined, typed: true, gone: gone("stopped") }))).toMatchObject({ ok: false, code: "STOPPED_DESTINATION" })
    expect(prepareFundsOut(transfer("tee-one").map((w, i) => (i === 8 ? "cold" : w)), ctx({ asked: undefined, typed: true, gone: gone("retired") }))).toMatchObject({ ok: false, code: "RETIRED_DESTINATION" })
    expect(prepareFundsOut(fund, ctx({ asked: undefined, typed: true, gone: () => undefined }))).toMatchObject({ ok: true })
  })

  test("vault fund and vault demote go by the destination rules too", () => {
    expect(prepareFundsOut(["vault", "fund", TEE, "--asset", "SOL", "--amount", "0.02"], ctx({ asked: "fund tee-one with 0.02 SOL" }))).toMatchObject({ ok: true })
    expect(prepareFundsOut(["vault", "fund", NEW, "--asset", "SOL", "--amount", "0.02"], ctx({ asked: `fund ${NEW} with 0.02 SOL` }))).toMatchObject({ ok: true, newAddress: inGroupsOfFour(NEW) })
    expect(prepareFundsOut(["vault", "fund", LOOKALIKE, "--asset", "SOL", "--amount", "0.02"], ctx({ typed: true }))).toMatchObject({ ok: false, code: "LOOKALIKE_DESTINATION" })
    expect(prepareFundsOut(["vault", "fund", TEE, "--asset", "SOL", "--amount", "0.02"], ctx({ asked: "fund tee-one" }))).toMatchObject({ ok: false, code: "ASK_FOR_IT_YOURSELF" })
    expect(prepareFundsOut(["vault", "demote", TEE, "--sweep-to", LOOKALIKE], ctx({ typed: true }))).toMatchObject({ ok: false, code: "LOOKALIKE_DESTINATION" })
    expect(prepareFundsOut(["vault", "demote", TEE], ctx({ typed: true }))).toMatchObject({ ok: true })
    // Several wallets (CLI 0.13.11): one unlock and one confirm, and the card says how many; one says nothing extra.
    expect((prepareFundsOut(["vault", "demote", TEE], ctx({ typed: true })) as { notes: string[] }).notes).toEqual([])
    const batch = prepareFundsOut(["vault", "demote", TEE, "--rpc-url", "https://rpc.example.test", "Tee2Fake11111111111111111111111111111111111"], ctx({ typed: true })) as { ok: true; notes: string[] }
    expect(batch.notes).toEqual(["Demotes 2 TEE wallets, one after another under one unlock and one confirm: each is stopped for good, then swept to its pinned vault."])
    // --all --empty names no wallet: refused typed or from the agent, whatever the user's words.
    for (const words of [["vault", "demote", "--all", "--empty"], ["vault", "demote", "--empty", "--all"]]) {
      expect(prepareFundsOut(words, ctx({ typed: true }))).toMatchObject({ ok: false, code: "NAME_EACH_WALLET" })
      expect(prepareFundsOut(words, ctx({ asked: "demote all my empty TEE wallets" }))).toMatchObject({ ok: false, code: "NAME_EACH_WALLET" })
    }
  })
})

describe("names from the reads, and renames followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-dest-names-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("every linked wallet's label, trusted or not, and the vault keys; a rename follows by address", async () => {
    const d = new Destinations({ file: join(dir, "destinations.json"), portfolio: () => [] })
    d.readWallets({
      embedded: { wallets: { solana: { address: EMBEDDED } } },
      linked: { page: [{ address: TEE, label: "tee-one", walletKind: "tee" }, { address: TRUSTED, label: "ledger", trustedAt: 1 }, { address: VAULT, label: "imported" }] },
    })
    await d.setVaultList([{ address: VAULT, label: "cold", kind: "vault-key" }])
    expect(d.names()).toMatchObject({ embedded: [EMBEDDED], linked: [{ address: TEE, label: "tee-one", tee: true }, { address: TRUSTED, label: "ledger", tee: false }, { address: VAULT, label: "imported", tee: false }], vaultKeys: [{ address: VAULT, label: "cold" }] })
    await d.renamed([{ address: VAULT, name: "deep" }, { address: TRUSTED, name: "hw" }])
    expect(d.all().find((x) => x.address === VAULT)?.label).toBe("deep")
    expect(d.all().find((x) => x.address === TRUSTED)?.label).toBe("hw")
    // The kept vault list follows, across a restart.
    expect(readFileSync(join(dir, "destinations.json"), "utf8")).toContain('"deep"')
  })
})
