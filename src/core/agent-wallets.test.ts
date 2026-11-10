// Payable wallets per agent: which wallets each agent's key may pay from, from its
// status read (the embedded wallet), its profile-wallets read (the TEE wallets bound to its key) and
// the account's portfolio (labels and the active flag). Pins that one agent can't pay from
// another's wallet.
import { expect, test } from "bun:test"
import type { AgentStatus } from "./agent-status"
import { AgentWallets, joinTee, resolvePayer, type WalletDeps, walletsNote } from "./agent-wallets"
import type { ToolOutcome } from "./candle-mcp"

const EMBEDDED = "WalletFake111111111111111111111111111111111"
const T1 = { id: "teeid1", address: "TeeOne11111111111111111111111111111111111111", label: "Bot Wallet" }
const T2 = { id: "teeid2", address: "TeeTwo11111111111111111111111111111111111111", label: "spare" }
const T3 = { id: "teeid3", address: "TeeThree1111111111111111111111111111111111", label: "swing-tee" }
const HOOD = { id: "teeid4", address: "0x00000000000000000000000000000000000Ho0d1", label: "hood-bot" }
const PREFIX: Record<string, string> = { momentum: "Momentum", swing: "Swingkey" }

const status = (extra: Partial<AgentStatus> = {}): AgentStatus => ({
  readAt: 1,
  wallets: { solana: EMBEDDED },
  embeddedWallet: "allowed",
  tier: "max",
  unreadable: [],
  ...extra,
})

const profileRow = (w: { id: string; address: string; label?: string }, chain = "solana", spendCapable = true) => ({
  address: w.address,
  assignedAt: 1_790_000_000_000,
  chain,
  ...(w.label ? { label: w.label } : {}),
  linkedWalletId: w.id,
  spendCapable,
})

/** The account's portfolio: every TEE wallet on it, whichever key holds it (in the recorded shape). */
const portfolio = (active: Record<string, boolean> = {}) => ({
  embedded: [{ chain: "solana", address: EMBEDDED, lamports: "0", tokens: [] }],
  tee: [T1, T2, T3].map((w) => ({ ...w, active: active[w.id] ?? true, chain: "solana", lamports: "0", tokens: [] })),
  hood: { embedded: [], tee: [{ ...HOOD, active: true, chain: "hood", wei: "0", tokens: [] }] },
})

interface Fixture {
  statuses?: Record<string, AgentStatus | undefined>
  /** Each agent's candle_get_profile_wallets answer, or an outcome to return instead. */
  profiles?: Record<string, unknown>
  portfolio?: unknown
  defaults?: Record<string, string>
  teeStatus?: (agent: string, address: string) => "bound" | "not_on_key" | "unreadable"
  noPrefix?: boolean
  pins?: WalletDeps["pins"]
  imported?: WalletDeps["imported"]
  /** Each agent's candle_get_trading_wallets answer; the tool answers as unknown for an agent not here. */
  trading?: Record<string, unknown>
  /** The tools each agent's MCP server lists; unset, the client has no tool list. */
  tools?: Record<string, string[]>
}

function wallets(f: Fixture = {}) {
  let clock = 1_000
  const calls: { agent: string; tool: string; args: Record<string, unknown> }[] = []
  const statuses = { momentum: status(), swing: status(), ...f.statuses }
  const profiles: Record<string, unknown> = {
    momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1)] },
    swing: { keyPrefix: "Swingkey", walletScope: "selected", wallets: [profileRow(T3)] },
    ...f.profiles,
  }
  const teeAsked: string[] = []
  const deps: WalletDeps = {
    pool: {
      for: (agent) => ({
        ...(f.tools ? { tools: () => (f.tools![agent] ?? []).map((name) => ({ name })) } : {}),
        call: async (tool, args): Promise<ToolOutcome> => {
          calls.push({ agent, tool, args })
          if (tool === "candle_get_trading_wallets") {
            const given = f.trading?.[agent]
            // A function answers each page by the cursor it's asked for; undefined from it is a failed read.
            const t = typeof given === "function" ? (given as (args: Record<string, unknown>) => unknown)(args) : given
            if (t === undefined && typeof given === "function") return { kind: "error", code: "UPSTREAM", retryable: true, body: {} }
            return t === undefined ? { kind: "error", code: "UNKNOWN_TOOL", retryable: false, body: {} } : { kind: "ok", result: t }
          }
          const answer = profiles[agent]
          if (answer && typeof answer === "object" && "kind" in answer) return answer as ToolOutcome
          return { kind: "ok", result: answer }
        },
      }),
    },
    status: { get: (agent) => statuses[agent as keyof typeof statuses], refresh: async (agent) => statuses[agent as keyof typeof statuses] },
    agents: () => ["momentum", "swing"],
    keyPrefix: (agent) => (f.noPrefix ? undefined : PREFIX[agent]),
    portfolio: () => (f.portfolio === undefined ? portfolio() : f.portfolio),
    teeStatus: async (agent, address) => {
      teeAsked.push(`${agent} ${address}`)
      return f.teeStatus?.(agent, address) ?? "not_on_key"
    },
    defaultWallet: (agent) => f.defaults?.[agent],
    ...(f.pins ? { pins: f.pins } : {}),
    ...(f.imported ? { imported: f.imported } : {}),
    now: () => clock,
  }
  const book = new AgentWallets(deps)
  return { book, calls, teeAsked, profiles, statuses, tick: (ms: number) => (clock += ms) }
}

test("a bound TEE wallet is its own agent's only, joined to the portfolio for its label and active flag", async () => {
  const w = wallets()
  await w.book.refreshAll()
  expect(w.calls.filter((c) => c.tool === "candle_get_profile_wallets").map((c) => [c.agent, c.args])).toEqual([
    ["momentum", { keyPrefix: "Momentum" }],
    ["swing", { keyPrefix: "Swingkey" }],
  ])
  const momentum = w.book.payable("momentum")
  expect(momentum.embedded).toEqual({ address: EMBEDDED, chain: "solana" })
  expect(momentum.tee).toEqual([{ id: T1.id, address: T1.address, label: "Bot Wallet", chain: "solana", active: true }])
  expect(momentum.readAt).toBe(1_000)
  expect(momentum.unreadable).toEqual([])
  expect(w.book.payable("swing").tee.map((t) => t.id)).toEqual([T3.id])
  expect(w.book.boundTo(T1.address)).toBe("momentum")
  expect(w.book.boundTo(T3.address)).toBe("swing")
  // T2 is on the account but on no agent's key (another key, or a revoked one): nobody's.
  expect(w.book.boundTo(T2.address)).toBeUndefined()
  expect(w.book.teeOnKey("Momentum").map((t) => t.label)).toEqual(["Bot Wallet"])
  expect(w.book.teeOnKey("Nobody12")).toEqual([])
})

test("under walletScope all an empty list says nothing about binding, so each TEE wallet is asked of the CLI", async () => {
  const w = wallets({
    profiles: { momentum: { keyPrefix: "Momentum", walletScope: "all", wallets: [] } },
    teeStatus: (agent, address) => (agent === "momentum" && address === T1.address ? "bound" : "not_on_key"),
  })
  await w.book.refresh("momentum")
  expect(w.teeAsked).toEqual([T1, T2, T3].map((t) => `momentum ${t.address}`))
  expect(w.book.payable("momentum").tee.map((t) => t.id)).toEqual([T1.id])
  expect(w.book.boundTo(T2.address)).toBeUndefined()
  // A wallet the CLI couldn't answer for makes the read unreadable, never a quiet "not bound".
  const u = wallets({ profiles: { momentum: { keyPrefix: "Momentum", walletScope: "all", wallets: [] } }, teeStatus: () => "unreadable" })
  await u.book.refresh("momentum")
  expect(u.book.payable("momentum")).toMatchObject({ tee: [], readAt: undefined, unreadable: ["tee wallets"] })
})

test("a row that isn't spendCapable stays listed and isn't payable; one the portfolio doesn't list as TEE isn't listed", async () => {
  const w = wallets({
    profiles: { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1, "solana", false), profileRow({ id: "imported", address: "Imp1111111111111111111111111111111111111111" })] } },
  })
  await w.book.refresh("momentum")
  expect(w.book.payable("momentum").tee).toEqual([{ id: T1.id, address: T1.address, label: "Bot Wallet", chain: "solana", active: false, cantSign: true }])
  const refused = w.book.payer("momentum", "Bot Wallet")
  expect(refused).toMatchObject({ ok: false, code: "TEE_WALLET_CANT_SIGN" })
  // Not a stopped wallet: nothing points the agent at an enable or a rebind.
  expect(refused.ok === false && refused.message).toContain("Candle doesn't list Bot Wallet as able to sign for momentum's key yet")
  expect(refused.ok === false && refused.message).not.toContain("is stopped")
  expect(w.book.boundTo(T1.address)).toBe("momentum")
})

test("a promoted wallet the key's list calls unable to sign, under another id, pays when the trading read says it's active", async () => {
  // As read live: the key's list says spendCapable false, under a linkedWalletId that isn't the portfolio's id for it; the
  // trading read lists it active under the portfolio's id.
  const profiles = { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [{ ...profileRow({ ...T1, id: "otherrow1" }, "solana", false) }, { ...profileRow({ ...HOOD, id: "otherrow4" }, "evm", false) }] } }
  const trading = {
    momentum: {
      success: true,
      keyPrefix: "Momentum",
      page: [
        { id: T1.id, address: T1.address, chain: "solana", label: T1.label, active: true, walletKind: "tee" },
        { id: HOOD.id, address: HOOD.address.toLowerCase(), chain: "evm", label: HOOD.label, active: true, walletKind: "tee" },
      ],
      isDone: true,
      continueCursor: null,
    },
  }
  const w = wallets({ profiles, trading })
  await w.book.refresh("momentum")
  expect(w.book.payable("momentum").tee).toEqual([
    { id: T1.id, address: T1.address, label: "Bot Wallet", chain: "solana", active: true },
    { id: HOOD.id, address: HOOD.address, label: "hood-bot", chain: "hood", active: true },
  ])
  expect(w.book.payer("momentum", "Bot Wallet")).toMatchObject({ ok: true, kind: "tee", address: T1.address, id: T1.id })
  expect(w.calls.filter((c) => c.agent === "momentum").map((c) => c.tool)).toEqual(["candle_get_profile_wallets", "candle_get_trading_wallets"])

  // Without the trading read (an older CLI's MCP server), the key's list stands: unable to sign, said so.
  const old = wallets({ profiles, tools: { momentum: ["candle_get_profile_wallets"] } })
  await old.book.refresh("momentum")
  expect(old.book.payable("momentum").tee.map((t) => ({ address: t.address, active: t.active, cantSign: t.cantSign }))).toEqual([
    { address: T1.address, active: false, cantSign: true },
    { address: HOOD.address, active: false, cantSign: true },
  ])
  // Its server doesn't list the tool, so it isn't called.
  expect(old.calls.some((c) => c.tool === "candle_get_trading_wallets")).toBe(false)
})

test("the trading read says what may trade: inactive there is unable to sign; a wallet only it names is bound too; a failed read changes nothing", async () => {
  const trading = (page: unknown[], isDone = true) => ({ momentum: { success: true, page, isDone } })
  const off = wallets({ trading: trading([{ id: T1.id, address: T1.address, chain: "solana", active: false, walletKind: "tee" }]) })
  await off.book.refresh("momentum")
  expect(off.book.payable("momentum").tee).toMatchObject([{ address: T1.address, active: false, cantSign: true }])
  const more = wallets({ trading: trading([{ id: T1.id, address: T1.address, chain: "solana", active: true, walletKind: "tee" }, { id: T2.id, address: T2.address, chain: "solana", active: true, walletKind: "tee" }, { id: "emb", address: EMBEDDED, chain: "solana", active: true, walletKind: "embedded" }]) })
  await more.book.refresh("momentum")
  expect(more.book.payable("momentum").tee.map((t) => [t.address, t.active])).toEqual([[T1.address, true], [T2.address, true]])
  expect(more.book.boundTo(T2.address)).toBe("momentum")
  // A page that says more follow: a wallet it doesn't name keeps the key's list's answer.
  const partial = wallets({ profiles: { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1, "solana", false)] } }, trading: trading([], false) })
  await partial.book.refresh("momentum")
  expect(partial.book.payable("momentum").tee).toMatchObject([{ address: T1.address, active: false, cantSign: true }])
  const failed = wallets({ trading: { momentum: "not a page" } })
  await failed.book.refresh("momentum")
  expect(failed.book.payable("momentum").tee).toMatchObject([{ address: T1.address, active: true }])
})

test("a fresh TEE wallet the portfolio doesn't list yet stays listed as unable to sign, across portfolio reads; an imported one doesn't", async () => {
  const FRESH = { id: "fresh", address: "Frsh111111111111111111111111111111111111111" }
  const IMPORTED = { id: "imp", address: "Imp2222222222222222222222222222222222222222" }
  const known = new Map<string, boolean>([[IMPORTED.address, true]])
  const w = wallets({
    profiles: { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow({ ...FRESH, label: "momentum-tee" }, "solana", false), profileRow(IMPORTED, "solana", false)] } },
    imported: (address) => known.get(address),
  })
  await w.book.refresh("momentum")
  expect(w.book.payable("momentum").tee).toEqual([{ id: FRESH.id, address: FRESH.address, label: "momentum-tee", chain: "solana", active: false, cantSign: true }])
  await w.book.refresh("momentum")
  expect(w.book.payable("momentum").tee.map((t) => t.address)).toEqual([FRESH.address])
  expect(w.book.payer("momentum", "momentum-tee")).toMatchObject({ ok: false, code: "TEE_WALLET_CANT_SIGN" })
})

test("the default wallet with nothing set: the embedded wallet when allowed, else the agent's only TEE wallet", async () => {
  const w = wallets({ statuses: { swing: status({ embeddedWallet: "denied" }) } })
  await w.book.refreshAll()
  expect(w.book.payer("momentum")).toEqual({ ok: true, kind: "embedded", address: EMBEDDED, chain: "solana" })
  expect(w.book.payer("swing")).toEqual({ ok: true, kind: "tee", address: T3.address, id: T3.id, label: "swing-tee", chain: "solana" })
  // The embedded wallet isn't listed for a denied key.
  expect(w.book.payable("swing").embedded).toBeUndefined()
})

test("a default wallet: it pays even where the embedded wallet is allowed; an unpayable default is refused, not swapped", async () => {
  const w = wallets({ defaults: { momentum: "bot wallet", swing: "Bot Wallet" } })
  await w.book.refreshAll()
  expect(w.book.payer("momentum")).toMatchObject({ ok: true, kind: "tee", address: T1.address })
  const swing = w.book.payer("swing")
  expect(swing).toMatchObject({ ok: false, code: "DEFAULT_WALLET_NOT_PAYABLE", canPayFrom: ["embedded", "swing-tee"] })
  expect(swing.ok === false && swing.message).toBe(
    `swing's default wallet (agents.swing.wallet = "Bot Wallet") can't pay: it's bound to momentum's key, and a TEE wallet is bound to one key only. It can pay from: embedded, swing-tee. Change it in config.toml, or name a wallet.`,
  )
  // A word given always wins over the default.
  expect(w.book.payer("swing", "embedded")).toMatchObject({ ok: true, kind: "embedded" })
})

test("payer resolves a label, an address or an id, and refuses anything else with the wallets it can pay from", async () => {
  const w = wallets()
  await w.book.refreshAll()
  for (const word of ["BOT WALLET", T1.address, T1.id]) expect(w.book.payer("momentum", word)).toMatchObject({ ok: true, kind: "tee", address: T1.address, label: "Bot Wallet" })
  expect(w.book.payer("momentum", EMBEDDED)).toMatchObject({ ok: true, kind: "embedded" })
  const unknown = w.book.payer("momentum", "moonbag")
  expect(unknown).toEqual({ ok: false, code: "WALLET_NOT_PAYABLE", message: "momentum can't pay from moonbag. It can pay from: embedded, Bot Wallet.", canPayFrom: ["embedded", "Bot Wallet"] })
  expect(w.book.payer("momentum", "swing-tee")).toMatchObject({ ok: false, code: "WALLET_NOT_PAYABLE", message: expect.stringContaining("it's bound to swing's key") })
  expect(w.book.payer("momentum", "spare")).toMatchObject({ ok: false, code: "WALLET_NOT_PAYABLE", message: expect.stringContaining("it's bound to another key") })
  // Terminal escapes in the word never reach the message.
  const escaped = w.book.payer("momentum", "a\u001b[2Jb")
  expect(escaped.ok === false && escaped.message).not.toContain("\u001b")
})

test("two TEE wallets and no embedded wallet: with no default, the trade has to name one", async () => {
  const w = wallets({
    statuses: { momentum: status({ embeddedWallet: "denied" }) },
    profiles: { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1), profileRow(T2)] } },
  })
  await w.book.refresh("momentum")
  expect(w.book.payer("momentum")).toMatchObject({ ok: false, code: "WALLET_NOT_NAMED", canPayFrom: ["Bot Wallet", "spare"] })
  const denied = w.book.payer("momentum", "embedded") as { ok: false; code: string; message: string }
  expect(denied.code).toBe("EMBEDDED_WALLET_NOT_PERMITTED")
  expect(denied.message).toContain("candle keys update Momentum --embedded-wallet allow")
  // The same line typed in the Candle Harness runs in its prompt pane: the refusal doesn't send the owner elsewhere.
  expect(denied.message).toContain("by typing this in the Candle Harness")
  expect(denied.message).not.toContain("own terminal")
})

test("the same label on two of its wallets is refused, asking for the address", async () => {
  const w = wallets({
    profiles: { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1), profileRow({ ...T2, label: "bot wallet" })] } },
    portfolio: { ...portfolio(), tee: [T1, { ...T2, label: "bot wallet" }].map((x) => ({ ...x, active: true, chain: "solana", lamports: "0", tokens: [] })) },
  })
  await w.book.refresh("momentum")
  expect(w.book.payer("momentum", "Bot Wallet")).toMatchObject({ ok: false, code: "WALLET_AMBIGUOUS" })
  expect(w.book.payer("momentum", T2.address)).toMatchObject({ ok: true, address: T2.address })
})

test("on Free, TEE wallets are a Pro or Max feature: shown, never payable", async () => {
  const w = wallets({ statuses: { momentum: status({ tier: "free" }), swing: status({ tier: "free", embeddedWallet: "denied" }) } })
  await w.book.refreshAll()
  expect(w.book.payable("momentum").tee).toHaveLength(1)
  expect(w.book.payable("momentum").tier).toBe("free")
  expect(w.book.payer("momentum", "Bot Wallet")).toMatchObject({ ok: false, code: "TEE_TIER_REQUIRED", message: expect.stringContaining("TEE wallets are a Pro or Max feature") })
  expect(w.book.payer("momentum")).toMatchObject({ ok: true, kind: "embedded" })
  expect(w.book.payer("swing")).toMatchObject({ ok: false, code: "TEE_TIER_REQUIRED", canPayFrom: [] })
})

test("a Hood TEE wallet is listed and not payable; an inactive one is refused, never picked by default", async () => {
  const w = wallets({
    statuses: { momentum: status({ embeddedWallet: "denied" }) },
    profiles: { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1), profileRow(HOOD, "hood")] } },
    portfolio: portfolio({ [T1.id]: false }),
  })
  await w.book.refresh("momentum")
  expect(w.book.payable("momentum").tee).toEqual([
    { id: T1.id, address: T1.address, label: "Bot Wallet", chain: "solana", active: false },
    { id: HOOD.id, address: HOOD.address, label: "hood-bot", chain: "hood", active: true },
  ])
  expect(w.book.payer("momentum", "hood-bot")).toMatchObject({ ok: false, code: "HOOD_TEE_LATER", message: expect.stringContaining("come in a later release") })
  expect(w.book.payer("momentum", "Bot Wallet")).toMatchObject({ ok: false, code: "TEE_WALLET_INACTIVE" })
  expect(w.book.payer("momentum")).toMatchObject({ ok: false, code: "NO_PAYABLE_WALLET", canPayFrom: [] })
})

test("a failed read keeps the last answer, marked with its age; never read is unknown, not empty", async () => {
  const w = wallets()
  expect(w.book.payable("momentum")).toMatchObject({ tee: [], readAt: undefined })
  await w.book.refresh("momentum")
  w.tick(4_000)
  w.profiles.momentum = { kind: "lost", reason: "timeout" }
  await w.book.refresh("momentum")
  expect(w.book.payable("momentum")).toMatchObject({ readAt: 1_000, unreadable: ["tee wallets"], tee: [{ id: T1.id }] })
  expect(w.book.payer("momentum", "Bot Wallet")).toMatchObject({ ok: true })
  // Never read: a word naming a TEE wallet says the read is missing, not that it isn't the agent's.
  const fresh = wallets({ profiles: { momentum: { kind: "error", code: "UNAUTHORIZED", retryable: false, body: {} } } })
  await fresh.book.refresh("momentum")
  expect(fresh.book.payer("momentum", "Bot Wallet")).toMatchObject({ ok: false, code: "WALLET_NOT_PAYABLE", message: expect.stringContaining("couldn't read which TEE wallets its key holds") })
  // And with no status read at all, nothing is guessed.
  const none = wallets({ statuses: { momentum: undefined } })
  expect(none.book.payer("momentum")).toMatchObject({ ok: false, code: "WALLETS_UNKNOWN" })
})

test("an agent whose key has no prefix can't be asked about its TEE wallets", async () => {
  const w = wallets({ noPrefix: true })
  await w.book.refresh("momentum")
  expect(w.calls.filter((c) => c.tool === "candle_get_profile_wallets")).toEqual([])
  expect(w.book.payable("momentum").unreadable).toEqual(["tee wallets"])
})

test("the agent is told what a trade naming no wallet pays from, and what else it can name", async () => {
  const w = wallets({ defaults: { momentum: "Bot Wallet" } })
  expect(walletsNote(w.book.view(), "momentum")).toBeUndefined()
  await w.book.refreshAll()
  expect(walletsNote(w.book.view(), "momentum")).toBe(
    "Your wallets (momentum): A trade or swap that names no wallet pays from Bot Wallet, a TEE wallet (TeeO…1111) bound to your key alone, the user's default for you. You can also pay from the embedded wallet, by passing wallet. " +
      "candle_execution_status lists only the embedded wallet, but your TEE wallets pay all the same. Leave wallet out unless the user names one.",
  )
  expect(walletsNote(w.book.view(), "swing")).toBe(
    "Your wallets (swing): A trade or swap that names no wallet pays from the embedded wallet. You can also pay from swing-tee, a TEE wallet (TeeT…1111) bound to your key alone, by passing wallet. " +
      "candle_execution_status lists only the embedded wallet, but your TEE wallets pay all the same. Leave wallet out unless the user names one.",
  )
})

test("a default that can't pay is said to the agent as the refusal it would get", async () => {
  const w = wallets({ defaults: { swing: "Bot Wallet" } })
  await w.book.refreshAll()
  expect(walletsNote(w.book.view(), "swing")).toStartWith("Your wallets (swing): A trade or swap that names no wallet is refused: swing's default wallet")
})

test("at 50 wallets, a refusal names the first six it can pay from and a count, not a wall of names", () => {
  const tee = Array.from({ length: 12 }, (_, n) => ({ id: `t${n}`, address: `TeeMany${"ABCDEFGHJKLM"[n]}`.padEnd(44, "1"), label: `bot-${n + 1}`, chain: "solana" as const, active: true }))
  const wide = resolvePayer({ agent: "momentum", payable: { embedded: { address: "Embd".padEnd(44, "1"), chain: "solana" }, tee, readAt: 1, unreadable: [], tier: "max" }, embeddedWallet: "allowed", account: tee, boundTo: () => "momentum" }, "moonbag") as { ok: false; message: string; canPayFrom: string[] }
  expect(wide.ok).toBe(false)
  expect(wide.message).toContain("It can pay from: embedded, bot-1, bot-2, bot-3, bot-4, bot-5 and 7 more (the Wallets pane lists them).")
  expect(wide.canPayFrom).toHaveLength(13)
})

test("a refusal names the embedded wallet by its own name, saying it's the embedded one", () => {
  const embedded = "Embd".padEnd(44, "1")
  const tee = [{ id: "t1", address: "TeeOne".padEnd(44, "1"), label: "pass-tee", chain: "solana" as const, active: true }]
  const names = [{ address: embedded, kind: "embedded" as const, name: "main", owner: "harness" as const }]
  const r = resolvePayer({ agent: "momentum", payable: { embedded: { address: embedded, chain: "solana" }, tee, readAt: 1, unreadable: [], tier: "max" }, embeddedWallet: "allowed", account: tee, boundTo: () => "momentum", names }, "moonbag") as { ok: false; message: string; canPayFrom: string[] }
  expect(r.message).toContain("It can pay from: main (embedded), pass-tee.")
  // The words a view types back stay as they were.
  expect(r.canPayFrom).toEqual(["embedded", "pass-tee"])
})

/** Pins kept in memory, as DefaultPins keeps them in its file. */
function memoryPins() {
  const kept: Record<string, { setting: string; address: string }> = {}
  return {
    kept,
    get: (agent: string, setting: string | undefined) => (setting !== undefined && kept[agent]?.setting === setting ? kept[agent]!.address : undefined),
    set: (agent: string, setting: string, address: string) => void (kept[agent] = { setting, address }),
  }
}

test("a renamed default still pays from its address: found once by its line, kept by address", async () => {
  const pins = memoryPins()
  const account = portfolio()
  const w = wallets({ defaults: { momentum: "Bot Wallet" }, pins, portfolio: account })
  await w.book.refreshAll()
  // Found by its line once the wallets are read, before anything renames it.
  expect(pins.kept.momentum).toEqual({ setting: "Bot Wallet", address: T1.address })
  // Candle renames it: the line's name is now no wallet's, and the default still pays from the same address.
  account.tee.find((t) => t.id === T1.id)!.label = "hot"
  expect(w.book.payer("momentum")).toMatchObject({ ok: true, kind: "tee", address: T1.address, label: "hot" })
  expect(w.book.view().agents.momentum).toMatchObject({ defaultWallet: "Bot Wallet", defaultPin: T1.address })
  expect(walletsNote(w.book.view(), "momentum")).toContain("pays from hot, a TEE wallet")
  // Without the pin, as before this fix: refused.
  expect(resolvePayer({ ...ctxOf(w.book, "momentum"), defaultWallet: "Bot Wallet" })).toMatchObject({ ok: false, code: "DEFAULT_WALLET_NOT_PAYABLE" })
})

test("the old name given to another wallet never moves the default there; an edited line is found again", async () => {
  const pins = memoryPins()
  const account = portfolio()
  const defaults: Record<string, string> = { momentum: "Bot Wallet" }
  const w = wallets({
    defaults,
    pins,
    portfolio: account,
    profiles: { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1), profileRow(T2)] } },
  })
  await w.book.refreshAll()
  account.tee.find((t) => t.id === T1.id)!.label = "hot"
  account.tee.find((t) => t.id === T2.id)!.label = "Bot Wallet"
  expect(w.book.payer("momentum")).toMatchObject({ ok: true, address: T1.address })
  // A word given is still read as it's written: "Bot Wallet" now names T2.
  expect(w.book.payer("momentum", "Bot Wallet")).toMatchObject({ ok: true, address: T2.address })
  // The person edits the line: it's found by its new words, and kept by that address.
  defaults.momentum = "hot"
  expect(w.book.payer("momentum")).toMatchObject({ ok: true, address: T1.address })
  expect(pins.kept.momentum).toEqual({ setting: "hot", address: T1.address })
  defaults.momentum = "Bot Wallet"
  expect(w.book.payer("momentum")).toMatchObject({ ok: true, address: T2.address })
  expect(pins.kept.momentum).toEqual({ setting: "Bot Wallet", address: T2.address })
})

test("a pinned default that can't pay is refused, never swapped for the wallet its old name now names", async () => {
  const pins = memoryPins()
  const account = portfolio({ [T1.id]: false })
  pins.set("momentum", "Bot Wallet", T1.address)
  account.tee.find((t) => t.id === T2.id)!.label = "Bot Wallet"
  const w = wallets({
    defaults: { momentum: "Bot Wallet" },
    pins,
    portfolio: account,
    profiles: { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1), profileRow(T2)] } },
  })
  await w.book.refreshAll()
  const picked = w.book.payer("momentum")
  expect(picked).toMatchObject({ ok: false, code: "DEFAULT_WALLET_NOT_PAYABLE" })
  expect(picked.ok === false && picked.message).toContain(`(agents.momentum.wallet = "Bot Wallet") can't pay: it's stopped on Candle's side`)
  expect(pins.kept.momentum).toEqual({ setting: "Bot Wallet", address: T1.address })
})

/** The PayerContext the book builds, without its default, for resolvePayer by hand. */
function ctxOf(book: AgentWallets, agent: string) {
  const view = book.view()
  const a = view.agents[agent]!
  return { agent, payable: a.payable, embeddedWallet: a.embeddedWallet, account: view.account, boundTo: (x: string) => view.boundTo[x] }
}

/** A Pro account with the Solana embedded wallet, the EVM one, one Solana TEE wallet and one Hood TEE wallet, all on the key. */
function twoChains(chain?: "solana" | "hood", defaultWallet?: string) {
  const EVM = "0x" + "a1".repeat(20)
  const tee = [
    { ...T1, chain: "solana", active: true },
    { ...HOOD, chain: "hood", active: true },
  ]
  return {
    evm: EVM,
    ctx: {
      agent: "momentum",
      payable: { embedded: { address: EMBEDDED, chain: "solana" as const }, tee, readAt: 1, unreadable: [], tier: "pro" },
      embeddedWallet: "allowed" as const,
      evm: EVM,
      account: tee,
      boundTo: () => "momentum",
      ...(chain ? { chain } : {}),
      ...(defaultWallet ? { defaultWallet } : {}),
    },
  }
}

test("a Solana TEE wallet never pays for a Hood trade, named by address or by name", () => {
  const { ctx } = twoChains("hood")
  for (const word of [T1.address, "Bot Wallet"]) {
    const r = resolvePayer(ctx, word)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe("WRONG_CHAIN")
    expect(r.ok === false && r.message).toContain("is a Solana wallet, and this trade is on Hood")
  }
})

test("a Solana TEE wallet set as the default is refused for a Hood trade, not used", () => {
  const { ctx } = twoChains("hood", "Bot Wallet")
  const r = resolvePayer(ctx)
  expect(r.ok).toBe(false)
  expect(r.ok === false && r.code).toBe("DEFAULT_WALLET_NOT_PAYABLE")
  expect(r.ok === false && r.message).toContain("can't pay: it's a Solana wallet, and this trade is on Hood")
})

test("the EVM embedded address named for a Solana trade is refused, never swapped for the Solana embedded wallet", () => {
  const { ctx, evm } = twoChains("solana")
  const r = resolvePayer(ctx, evm)
  expect(r.ok === false && r.code).toBe("WRONG_CHAIN")
  expect(r.ok === false && r.message).toContain("is a Hood wallet, and this trade is on Solana")
})

test("the Solana embedded address named for a Hood trade is refused, never swapped for the EVM embedded wallet", () => {
  const { ctx } = twoChains("hood")
  const r = resolvePayer(ctx, EMBEDDED)
  expect(r.ok === false && r.code).toBe("WRONG_CHAIN")
  expect(r.ok === false && r.message).toContain("is a Solana wallet, and this trade is on Hood")
})

test("a wallet on the trade's own chain still pays: embedded on either chain, the Solana TEE wallet for a Solana trade", () => {
  const hood = twoChains("hood")
  expect(resolvePayer(hood.ctx, "embedded")).toMatchObject({ ok: true, kind: "embedded", address: hood.evm, chain: "hood" })
  expect(resolvePayer(hood.ctx, hood.evm.toUpperCase().replace("0X", "0x"))).toMatchObject({ ok: true, kind: "embedded", chain: "hood" })
  expect(resolvePayer(hood.ctx)).toMatchObject({ ok: true, kind: "embedded", chain: "hood" })
  const sol = twoChains("solana")
  expect(resolvePayer(sol.ctx, EMBEDDED)).toMatchObject({ ok: true, kind: "embedded", address: EMBEDDED, chain: "solana" })
  expect(resolvePayer(sol.ctx, "Bot Wallet")).toMatchObject({ ok: true, kind: "tee", address: T1.address })
  expect(resolvePayer(twoChains(undefined, "Bot Wallet").ctx)).toMatchObject({ ok: true, kind: "tee", address: T1.address })
  // A Hood TEE wallet is still refused as before, whichever chain the trade is on.
  expect(resolvePayer(hood.ctx, "hood-bot")).toMatchObject({ ok: false, code: "HOOD_TEE_LATER" })
})

test("a default of embedded, pinned to the Solana address, still pays for a Hood trade", async () => {
  const pins = memoryPins()
  const w = wallets({ defaults: { momentum: "embedded" }, pins, statuses: { momentum: status({ wallets: { solana: EMBEDDED, evm: "0x" + "a1".repeat(20) } }) } })
  await w.book.refreshAll()
  // The pin lands on the Solana embedded address, as the startup pass keeps it.
  expect(pins.kept.momentum).toEqual({ setting: "embedded", address: EMBEDDED })
  expect(w.book.payer("momentum", undefined, { chain: "hood" })).toMatchObject({ ok: true, kind: "embedded", chain: "hood" })
  expect(w.book.payer("momentum", undefined, { chain: "solana" })).toMatchObject({ ok: true, kind: "embedded", chain: "solana" })
})

test("a default that is a name for the Solana embedded wallet pays for a Hood trade as the embedded wallet", () => {
  const { ctx } = twoChains("hood")
  expect(resolvePayer({ ...ctx, defaultWallet: "embedded", defaultPin: EMBEDDED })).toMatchObject({ ok: true, kind: "embedded", chain: "hood" })
  expect(resolvePayer({ ...ctx, chain: "solana", defaultWallet: "embedded", defaultPin: ctx.evm })).toMatchObject({ ok: true, kind: "embedded", chain: "solana" })
})

test("the key's list joins the portfolio by address, not id: another id, an EVM address in another case; a Solana address only exactly, and never a Hood entry", () => {
  const portfolio = { tee: [{ id: "p-sol", address: T1.address, label: "Bot Wallet", active: true }], hood: { tee: [{ id: "p-hood", address: HOOD.address.toLowerCase(), label: "hood-bot", active: true }] } }
  // An older server, with no trading read to rewrite the ids: the key's list names each wallet by an id of its own.
  const rows = [
    { id: "k-sol", address: T1.address, chain: "solana", spendCapable: true },
    { id: "k-hood", address: HOOD.address, chain: "evm", spendCapable: true },
  ]
  expect(joinTee(rows, portfolio)).toEqual([
    { id: "p-sol", address: T1.address, label: "Bot Wallet", chain: "solana", active: true },
    { id: "p-hood", address: HOOD.address, label: "hood-bot", chain: "hood", active: true },
  ])
  // A Solana address in another case is another wallet: base58 tells cases apart, so it isn't the portfolio's.
  const otherCase = T1.address.toLowerCase()
  expect(joinTee([{ id: "k-x", address: otherCase, chain: "solana", spendCapable: false }], portfolio)).toEqual([{ id: "k-x", address: otherCase, chain: "solana", active: false, cantSign: true }])
  // A Solana row never takes a Hood entry's place, whatever its address reads as.
  const odd = HOOD.address.toUpperCase().replace("0X", "0x")
  expect(joinTee([{ id: "k-y", address: odd, chain: "solana", spendCapable: false }], portfolio)).toEqual([{ id: "k-y", address: odd, chain: "solana", active: false, cantSign: true }])
})

test("the trading read is read to its last page, and a complete one decides: a wallet it leaves out can't pay; a read cut short decides nothing for the wallets it didn't reach", async () => {
  const profiles = { momentum: { keyPrefix: "Momentum", walletScope: "selected", wallets: [profileRow(T1), profileRow(T2)] } }
  const row = (w: { id: string; address: string }) => ({ id: w.id, address: w.address, chain: "solana", active: true, walletKind: "tee" })
  // Two pages: T1 on the first, T2 on the second, reached by the first page's cursor.
  const paged = wallets({ profiles, trading: { momentum: (args: Record<string, unknown>) => (args.cursor === "c1" ? { page: [row(T2)], isDone: true } : { page: [row(T1)], isDone: false, continueCursor: "c1" }) } })
  await paged.book.refresh("momentum")
  expect(paged.book.payable("momentum").tee.map((t) => [t.address, t.active])).toEqual([[T1.address, true], [T2.address, true]])
  expect(paged.calls.filter((c) => c.tool === "candle_get_trading_wallets").map((c) => c.args)).toEqual([{}, { cursor: "c1" }])
  // Complete, and T2 isn't in it: the key's list said it could pay, the trading read says otherwise, and the trading read wins.
  const left = wallets({ profiles, trading: { momentum: { page: [row(T1)], isDone: true } } })
  await left.book.refresh("momentum")
  expect(left.book.payable("momentum").tee.map((t) => ({ address: t.address, active: t.active, cantSign: t.cantSign }))).toEqual([
    { address: T1.address, active: true, cantSign: undefined },
    { address: T2.address, active: false, cantSign: true },
  ])
  // The second page fails: T2 wasn't reached, so the key's list's answer stands for it.
  const cut = wallets({ profiles, trading: { momentum: (args: Record<string, unknown>) => (args.cursor === "c1" ? undefined : { page: [row(T1)], isDone: false, continueCursor: "c1" }) } })
  await cut.book.refresh("momentum")
  expect(cut.book.payable("momentum").tee.map((t) => [t.address, t.active])).toEqual([[T1.address, true], [T2.address, true]])
})
