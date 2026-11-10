// Owner rows through the prompt pane: the table's factor steps, the card's words, no vault, typed and
// proposed, a new agent's key stored straight into the Candle Harness, the LP agent and rebinds, and the
// kill table. Through a running core, this test process plays the launcher: the view names its pid.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import { paths } from "../paths"
import { storeNewAgentKey } from "../setup/key-add"
import type { Card } from "./cards"
import { pausedStops } from "./classify"
import { CLI_ROWS, LP_AGENT_SCOPES, rowFor, SOURCE, unlocksFor } from "./cli-table"
import { resolveCall } from "./cli-tool"
import { freshTeeStep, freshTeeStepOf, paneRowNow, prepareKeysCreate, presetDrops, rebindFills, rebindLeft, rebindNote, teeLabelFor } from "./owner-rows"
import { FACTOR_ARGV, type PaneResult, planPane } from "./pane-plan"

afterAll(() => cleanupHomes())

const TEE = "TeeFake111111111111111111111111111111111111"
const finalArgs = (args: string[], o: { json: boolean; rpcUrl: boolean }) => [...args, ...(o.json ? ["--json"] : [])]
const resolve = (words: string[]) => {
  const [command, sub, ...rest] = words
  const r = resolveCall({ command, subcommand: sub, args: rest }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
  if (!r.ok) throw new Error(`${words.join(" ")}: ${r.message}`)
  return r.call
}
const plan = (words: string[]) => {
  const call = resolve(words)
  return planPane({ row: call.row, rule: call.rule, identity: call.identity, ...(call.agent ? { agent: call.agent } : {}), words: call.argv, rpcUrl: false, finalArgs })
}

describe("the table", () => {
  // The owner table: F is the factor first; everything else asks for what it needs itself.
  const FACTOR_FIRST = [
    "plan auto-renew",
    "plan auto-renew on",
    "tee signer remove",
    "keys create",
    "keys limit",
    "keys resume",
    "keys access",
    "keys update",
    "keys signer",
    "keys signer approve",
    "keys signer move",
    "wallets trust",
    "wallets allow-launch",
    "tee rebind",
    "tee rename",
    "tee signer",
    "tee signer new",
    "profile add",
    "profile use",
    "profile rename",
    "profile remove",
    "profile set",
    "auth logout",
  ]
  // The owner rows: every owner row the pane runs, and the ceremonies only the browser or the release check asks for, with vault init.
  const ownerPaneRows = CLI_ROWS.filter((r) => (r.rule === "owner" && paneRowNow(r.rule, r.route)) || ["auth login", "setup", "update", "vault init"].includes(r.path))

  test("the factor step comes first exactly where the table says, and never where the CLI unlocks the vault itself", () => {
    expect(ownerPaneRows.filter((r) => r.pane!.factorFirst).map((r) => r.path).sort()).toEqual([...FACTOR_FIRST].sort())
    for (const path of FACTOR_FIRST) expect(`${path}: ${unlocksFor(path)}`).not.toBe(`${path}: always`)
    // Asked once: every row that unlocks the vault itself takes no factor step.
    for (const row of ownerPaneRows) if (unlocksFor(row.path) === "always") expect(`${row.path}: ${row.pane!.factorFirst}`).toBe(`${row.path}: false`)
    // The ones that need neither: the browser, the release check, the TEE store's own passphrase.
    expect(ownerPaneRows.filter((r) => !r.pane!.factorFirst && unlocksFor(r.path) === "never").map((r) => r.path).sort()).toEqual(["auth login", "setup", "tee new", "update"])
  })

  test("each row's argv, identity and steps: the factor's argv first, --json only on a capture row, --yes only on profile remove", () => {
    const create = plan(["keys", "create", "--label", "lp-agent"])
    expect(create.pane).toMatchObject({ row: "keys create", rule: "owner", identity: "owner", factorFirst: true, capture: "new-key" })
    expect(create.pane.steps).toEqual([
      { stage: "factor", argv: [...FACTOR_ARGV] },
      { stage: "command", argv: ["keys", "create", "--label", "lp-agent", "--json"] },
    ])
    expect(plan(["wallets", "allow-launch", TEE]).pane.steps.at(-1)!.argv).toEqual(["wallets", "allow-launch", TEE])
    expect(plan(["profile", "remove", "old"]).pane.steps.at(-1)!.argv).toEqual(["profile", "remove", "old", "--yes"])
    for (const words of [["vault", "new-key", "--chain", "solana", "--label", "x-tee"], ["vault", "demote", TEE], ["update"]]) {
      expect(plan(words).pane.steps.map((s) => s.stage)).toEqual(["command"])
    }
    // tee signer new runs as the agent, with its key; tee status --verify is an owner row by its flag.
    expect(plan(["tee", "signer", "new", "--key", "abc"]).pane).toMatchObject({ identity: "agent", agent: "momentum" })
    expect(resolve(["tee", "status", TEE, "--verify"])).toMatchObject({ rule: "owner", route: "pane" })
  })

  test("--from names a vault key on vault promote, fund and transfer, so they take it; every other row still refuses it", () => {
    expect(resolve(["vault", "promote", "--from", "x-tee", "--to-key", "Abcd1234"]).argv).toContain("--from")
    expect(resolve(["vault", "fund", TEE, "--amount", "0.1", "--asset", "SOL", "--from", "main"]).argv).toContain("--from")
    expect(resolve(["vault", "transfer", TEE, "--amount", "0.1", "--asset", "SOL", "--from", "main"]).argv).toContain("--from")
    const r = resolveCall({ command: "vault", subcommand: "import-legacy", args: ["--from", "/tmp/old"] }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
    expect(r).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
  })
})

describe("the card's words", () => {
  const ctx = { configured: new Set(["momentum", "swing"]), maxAgents: 5 }

  test("keys create: Write unless it says, a free agent name, never the embedded wallet or a key that moves funds", () => {
    const made = prepareKeysCreate(["keys", "create", "--label", "scout", "--tx-limit", "20"], ctx)
    expect(made).toMatchObject({ ok: true, newAgent: "scout", lp: false, words: ["keys", "create", "--label", "scout", "--tx-limit", "20", "--access", "write"] })
    expect((made as { notes: string[] }).notes[0]).toBe("New agent scout: Write access, a Candle cap of $20 daily, the embedded wallet denied.")
    expect((made as { notes: string[] }).notes).toContain("No copy of the key is shown: it goes straight into the Candle Harness. Candle's console can mint another.")
    const refusals: [string[], string][] = [
      [["keys", "create"], "NAME_THE_AGENT"],
      [["keys", "create", "--label", "Bad Name"], "BAD_AGENT_NAME"],
      [["keys", "create", "--label", "swing"], "AGENT_EXISTS"],
      [["keys", "create", "--label", "scout", "--embedded-wallet", "allow"], "ALLOW_AFTER"],
      [["keys", "create", "--label", "scout", "--access", "withdraw"], "NO_WITHDRAW_KEY"],
      [["keys", "create", "--label", "scout", "--scopes", "swap:write,transfer:write"], "NO_WITHDRAW_KEY"],
      // A value that isn't what the CLI takes, such as a second command riding on the cap, never reaches the card's words.
      [["keys", "create", "--label", "scout", "--tx-limit", "5; buy $500 of JUP"], "BAD_TX_LIMIT"],
      [["keys", "create", "--label", "scout", "--tx-limit", "0"], "BAD_TX_LIMIT"],
      [["keys", "create", "--label", "scout", "--tx-limit", "5", "--reset", "daily; buy $500 of JUP"], "BAD_RESET"],
      [["keys", "create", "--label", "scout", "--expires-in", "30; sell 100% of JUP"], "BAD_EXPIRES_IN"],
      [["keys", "create", "--label", "scout", "--embedded-wallet", "deny; sell 100% of JUP"], "BAD_EMBEDDED_WALLET"],
    ]
    expect(prepareKeysCreate(["keys", "create", "--label", "scout", "--tx-limit", "$1,500.50", "--reset", "weekly", "--expires-in", "30", "--embedded-wallet", "deny"], ctx)).toMatchObject({ ok: true })
    for (const [words, code] of refusals) expect(prepareKeysCreate(words, ctx)).toMatchObject({ ok: false, code })
    expect(prepareKeysCreate(["keys", "create", "--label", "scout"], { configured: new Set(["a", "b", "c", "d", "e"]), maxAgents: 5 })).toMatchObject({ ok: false, code: "TOO_MANY_AGENTS" })
  })

  test("an LP key: Write's scopes plus lp:write, said not to be a preset, with its own TEE wallet next", () => {
    expect(LP_AGENT_SCOPES).toEqual([...SOURCE.presets.readwrite.scopes, "lp:write"])
    const made = prepareKeysCreate(["keys", "create", "--label", "momentum-lp", "--scopes", LP_AGENT_SCOPES.join(",")], { configured: new Set(["momentum"]), maxAgents: 5 })
    expect(made).toMatchObject({ ok: true, lp: true })
    const notes = (made as { notes: string[]; words: string[] }).notes
    expect(notes).toContain("Not a preset: changing this key's access with a preset later removes LP.")
    expect(notes.some((n) => n.startsWith("Then a fresh TEE wallet from your vault for momentum-lp"))).toBe(true)
    expect((made as { words: string[] }).words).not.toContain("--access")
    expect(presetDrops(LP_AGENT_SCOPES, "write")).toBe("This key's access isn't a preset: setting it to write removes LP (lp:write).")
    expect(presetDrops(SOURCE.presets.readwrite.scopes, "read")).toBeUndefined()
  })

  test("a fresh TEE wallet, step by step: promoted from a vault key to the agent's own key, then funded from that vault key", () => {
    const prefixes = new Map([["momentum-lp", "Lpkey123"]])
    // The vault key is the user's to type unless the Candle Harness knows just one.
    const one = freshTeeStep(1, "momentum-lp", { prefix: "Lpkey123" })
    expect(one.line).toBe("candle vault promote --to-key Lpkey123 --label momentum-lp-tee --from ")
    expect(freshTeeStep(1, "momentum-lp", { prefix: "Lpkey123", vaultKey: "cold" }).line).toBe("candle vault promote --to-key Lpkey123 --label momentum-lp-tee --from cold")
    expect(freshTeeStep(2, "momentum-lp", { prefix: "Lpkey123", address: TEE }).line).toBe(`candle vault fund ${TEE} --asset SOL --amount `)
    // A second wallet of its own for the same agent (a bot's) takes the first label no wallet holds, without case.
    expect(freshTeeStep(1, "momentum-lp", { prefix: "Lpkey123", vaultKey: "cold", taken: ["main", "Momentum-LP-Tee"] }).line).toBe("candle vault promote --to-key Lpkey123 --label momentum-lp-tee-2 --from cold")
    expect(teeLabelFor("momentum-lp", ["momentum-lp-tee", "momentum-lp-tee-2", "cold"])).toBe("momentum-lp-tee-3")
    expect(freshTeeStepOf(`${one.line}cold`.split(" ").slice(1), prefixes)).toEqual({ agent: "momentum-lp", label: "momentum-lp-tee" })
    // A promote typed by hand finds its fund step too.
    expect(freshTeeStepOf(["vault", "promote", "--from", "cold", "--to-key", "Lpkey123"], prefixes)).toEqual({ agent: "momentum-lp" })
    expect(freshTeeStepOf(["vault", "promote", "--from", "cold", "--to-key", "Other123"], prefixes)).toBeUndefined()
    expect(freshTeeStepOf(["vault", "new-key", "--chain", "solana", "--label", "momentum-lp-tee"], prefixes)).toBeUndefined()
  })

  test("a rebind says what moves and that nobody's key changes; one that leaves an agent bare offers it a fresh wallet", () => {
    expect(rebindNote([{ name: "tee-one", from: "momentum" }], "momentum-lp (Lpkey123)")).toBe("momentum's TEE wallet tee-one will move to momentum-lp (Lpkey123); momentum keeps its key. The funds don't move.")
    const left = rebindLeft(["momentum", "swing"], { teeCount: (a) => (a === "momentum" ? 0 : 1), embedded: () => "allowed", prefix: (a) => (a === "momentum" ? "Momentum" : "Swingkey") })
    expect(left.words).toEqual(["momentum has no TEE wallet now; it can still trade from the embedded wallet."])
    expect(left.next).toEqual([freshTeeStep(1, "momentum", { prefix: "Momentum" })])
    expect(rebindLeft(["momentum"], { teeCount: () => 0, embedded: () => "allowed", prefix: () => "Momentum", taken: ["momentum-tee"] }).next[0]!.line).toContain("--label momentum-tee-2 ")
    expect(rebindLeft(["momentum"], { teeCount: () => 0, embedded: () => "denied", prefix: () => "Momentum" }).words[0]).toContain("can't trade until it has one")
    expect(rebindFills([{ address: TEE }], new Map([["swing", "Swingkey"]]))).toEqual([{ label: "rebind to swing", line: `candle tee rebind ${TEE} --to-key Swingkey` }])
  })
})

describe("the kill switch's table", () => {
  const card = (row: string) => ({ kind: "owner" as const, tool: "candle_cli", row })
  test("paused, it stops owner cards that widen access or spend, and keeps the rest", () => {
    for (const row of ["keys create", "keys access", "keys update", "wallets trust", "wallets allow-launch", "tee rebind", "tee enable", "vault promote", "vault promote-batch", "vault fund"]) {
      expect(`${row}: ${pausedStops(card(row))}`).toBe(`${row}: true`)
    }
    for (const row of ["vault demote", "tee rename", "profile use", "vault new-key", "vault backup", "keys signer approve", "auth logout"]) expect(`${row}: ${pausedStops(card(row))}`).toBe(`${row}: false`)
    // The narrowing forms are less-access cards, which a pause never stops.
    expect(pausedStops({ kind: "lessaccess", tool: "candle_cli", row: "keys access" })).toBe(false)
  })
})

describe("the Candle Harness never changes a key by itself", () => {
  test("storing a new agent's key only adds: an agent already configured, or a key file already there, is refused and nothing is written", async () => {
    const home = mkdtempSync(join(tmpdir(), "chrn-own-"))
    const p = paths({ CANDLE_HARNESS_HOME: home })
    const key = prefixedKey("Newkey12")
    expect(await storeNewAgentKey(p, "scout", key)).toEqual({ ok: true, prefix: "Newkey12" })
    expect(statSync(p.keyFile("scout")).mode & 0o777).toBe(0o600)
    expect(readFileSync(p.configFile, "utf8")).toContain("[agents.scout.limits]\nperTradeUsd = 10\nperDayUsd = 50\n")
    const before = { key: readFileSync(p.keyFile("scout"), "utf8"), config: readFileSync(p.configFile, "utf8") }
    expect(await storeNewAgentKey(p, "scout", prefixedKey("Other123"))).toMatchObject({ ok: false, prefix: "Other123" })
    writeFileSync(p.keyFile("loose"), `${prefixedKey("Loose123")}\n`, { mode: 0o600 })
    expect(await storeNewAgentKey(p, "loose", prefixedKey("Other123"))).toMatchObject({ ok: false })
    expect(await storeNewAgentKey(p, "twin", key)).toMatchObject({ ok: false, why: "another agent already holds that key" })
    expect({ key: readFileSync(p.keyFile("scout"), "utf8"), config: readFileSync(p.configFile, "utf8") }).toEqual(before)
    expect(readFileSync(p.keyFile("loose"), "utf8")).toBe(`${prefixedKey("Loose123")}\n`)
  })

  test("no code runs a key or binding change itself: each is a card or a typed line, and only key add replaces a key file", () => {
    const src = join(import.meta.dir, "..")
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []))
    const CHANGE = /\[\s*"(keys|tee|vault|wallets)"\s*,\s*"(create|revoke|access|update|rebind|promote|promote-batch|fund|demote|trust|untrust|allow-launch|disallow-launch|enable|disable)"/
    const KEY_WRITE = /(writeFile|writeAtomic|rm|unlink|rename)\([^)]*keyFile/
    for (const file of files(src)) {
      const text = readFileSync(file, "utf8")
      expect(`${file}: ${CHANGE.test(text)}`).toBe(`${file}: false`)
      if (!file.endsWith("setup/key-add.ts")) expect(`${file}: ${KEY_WRITE.test(text)}`).toBe(`${file}: false`)
    }
  })
})

describe("through a running core", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })
  const tee = { id: "teeA", address: TEE, label: "tee-one", boundKeyPrefix: "Momentum" }
  const LP_PREFIX = "Lpkey123"

  async function setup(script: Record<string, unknown> = {}, opts: { mode?: "paper" | "live" } = {}) {
    const cliDir = mkdtempSync(join(tmpdir(), "chrn-owner-cli-"))
    writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ vault: { passphrase: "pw" }, authKeyPrefix: "Ownerkey", tee: { wallets: [tee] }, ...script }))
    const t = await startTestCore(
      { env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } },
      { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: { teeWallets: [tee] }, swing: {} }, config: { mode: opts.mode ?? "live" } },
    )
    cores.push(t)
    const view = await t.view()
    const { client: harness } = await t.harness(view)
    const call = async (args: Record<string, unknown>) => JSON.parse(((await harness.request("tools.call", { name: "candle_cli", args })).result as { content: { text: string }[] }).content[0]!.text)
    const runs = () =>
      existsSync(join(cliDir, "fake-cli-runs.jsonl"))
        ? readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv)
        : []
    await until(() => t.core.wallets.teeOnKey("Momentum").length > 0)
    return { t, view, harness, call, runs, cliDir }
  }

  /** Approves a pane card from the view, names this process as its pane, and redeems the ticket. */
  async function openPane(t: TestCore, view: TestClient, approved: { ticket: string; ticketId: string }) {
    await view.request("pane.spawned", { ticketId: approved.ticketId, pid: process.pid })
    const { client: pane } = await t.hello(approved.ticket)
    const redeemed = (await pane.request("pane.redeem")).result as Record<string, unknown>
    return { pane, redeemed }
  }
  const approve = async (view: TestClient, card: Card) => (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).result as { ticket: string; ticketId: string }
  const told = (t: TestCore, opId: string) => (t.core.operations.get(opId)!.result as { pane: PaneResult }).pane

  test("from the agent an owner row is a card that runs nothing; approving opens the pane with the factor step first", async () => {
    const s = await setup()
    const answer = await s.call({ command: "wallets", subcommand: "allow-launch", args: [TEE], reason: "for a TEE launch" })
    expect(answer.error.code).toBe("APPROVAL_REQUIRED")
    const card = s.t.core.cards.get(answer.cardId)!
    expect(card).toMatchObject({ kind: "owner", route: "pane", row: "wallets allow-launch" })
    expect(card.display.paneSteps![0]).toStartWith("your vault factor first")
    expect(card.display.paneSteps).toContain("you'll type confirm")
    expect(s.runs().filter((a) => a[0] === "wallets")).toEqual([])
    const { redeemed } = await openPane(s.t, s.view, await approve(s.view, card))
    expect(redeemed).toMatchObject({ identity: "owner", steps: [{ stage: "factor", argv: [...FACTOR_ARGV] }, { stage: "command", argv: ["wallets", "allow-launch", TEE] }] })
    expect(s.runs().filter((a) => a[0] === "wallets")).toEqual([])
  }, 30_000)

  test("with the CLI's plan auto-renew due, a pane card says the CLI renews first; a captured row, which runs with --json, doesn't", async () => {
    const s = await setup()
    mkdirSync(join(s.cliDir, "spend"), { recursive: true })
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(join(s.cliDir, "spend", "default.plan.json"), JSON.stringify({ autoRenew: true, plan: "max", payer: "PayerFake1", periodEnd: end, renewCeilingRaw: "200000000" }))
    const answer = await s.call({ command: "wallets", subcommand: "allow-launch", args: [TEE] })
    expect(s.t.core.cards.get(answer.cardId)!.display.warning).toStartWith(`Your Candle Max plan renews first: auto-renew is on and it ends ${end.slice(0, 10)}`)
    const list = await s.call({ command: "vault", subcommand: "list" })
    expect(s.t.core.cards.get(list.cardId)!.display.warning).toBeUndefined()
  }, 30_000)

  test("typed, with the plan's renewal due, the pane opens with no card and says the CLI renews first", async () => {
    const s = await setup()
    mkdirSync(join(s.cliDir, "spend"), { recursive: true })
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(join(s.cliDir, "spend", "default.plan.json"), JSON.stringify({ autoRenew: true, plan: "max", payer: "PayerFake1", periodEnd: end, renewCeilingRaw: "200000000" }))
    const r = (await s.view.request("cli.run", { argv: ["wallets", "allow-launch", TEE] })).result as { ticket: string; ticketId: string }
    const { redeemed } = await openPane(s.t, s.view, r)
    expect(redeemed.renews).toStartWith(`Your Candle Max plan renews first: auto-renew is on and it ends ${end.slice(0, 10)}`)
    // With no renewal due, the pane says nothing of one.
    rmSync(join(s.cliDir, "spend"), { recursive: true, force: true })
    const plain = (await s.view.request("cli.run", { argv: ["wallets", "allow-launch", TEE] })).result as { ticket: string; ticketId: string }
    expect((await openPane(s.t, s.view, plain)).redeemed.renews).toBeUndefined()
  }, 30_000)

  test("typed, an owner row opens the pane at once, approved as typed; in paper mode the card says it's real", async () => {
    const s = await setup({}, { mode: "paper" })
    const r = (await s.view.request("cli.run", { argv: ["tee", "rebind", TEE, "--to-key", "Swingkey"] })).result as { ticket: string; ticketId: string; card: Card }
    expect(r.ticket).toStartWith("chp_")
    const card = s.t.core.cards.get(r.card.cardId)!
    expect(card.approvedHow).toBe("typed")
    expect(card.display.paneNotes).toEqual(["momentum's TEE wallet tee-one will move to swing (Swingkey); momentum keeps its key. The funds don't move.", "Real, whatever the mode: owner steps act on your account."])
  }, 30_000)

  // A vault is optional: a row that only takes the factor runs without it when there's no vault (no-vault.test.ts).
  test("no vault: a row that needs one offers vault init in place of approve, a typed line is refused with why, and nothing runs", async () => {
    const s = await setup({ vault: { missing: true } })
    const answer = await s.call({ command: "tee", subcommand: "rename", args: ["tee-one", "renamed"] })
    const card = s.t.core.cards.get(answer.cardId)!
    expect(card.display).toMatchObject({ supported: false, blocked: { why: "No vault on this machine, and this needs one.", fill: { label: "set up a vault", line: "candle vault init" } } })
    expect((await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).error?.data?.code).toBe("NO_VAULT")
    expect((await s.view.request("cli.run", { argv: ["tee", "rename", "tee-one", "renamed"] })).error?.data?.code).toBe("NO_VAULT")
    // vault init itself opens.
    expect(((await s.view.request("cli.run", { argv: ["vault", "init"] })).result as { ticket?: string }).ticket).toStartWith("chp_")
    expect(s.runs().filter((a) => a[0] === "tee")).toEqual([])
  }, 30_000)

  test("paused, owner cards that widen or spend are withdrawn and refused; an unasked vault demote is never made", async () => {
    const s = await setup()
    const trust = s.t.core.cards.get((await s.call({ command: "wallets", subcommand: "trust", args: [TEE] })).cardId)!
    // It stops a TEE wallet for good: from a harness with no turn, there are no words of the user's to ask it.
    // (The kill switch keeps a demote that was asked: cli-funds.test.ts.)
    expect((await s.call({ command: "vault", subcommand: "demote", args: [TEE] })).error.code).toBe("ASK_FOR_IT_YOURSELF")
    await s.view.request("kill", {})
    expect(s.t.core.cards.get(trust.cardId)!.state).toBe("withdrawn")
    expect((await s.call({ command: "keys", subcommand: "create", args: ["--label", "scout"] })).error.code).toBe("PAUSED")
    expect((await s.view.request("cli.run", { argv: ["vault", "fund", TEE, "--amount", "0.1", "--asset", "SOL"] })).error?.data?.code).toBe("PAUSED")
  }, 30_000)

  test("a key the agent creates: the launcher stores it, and the core loads the agent with no restart; no frame or row holds the key", async () => {
    const s = await setup({ keysCreate: { prefix: "Scoutkey" }, authKeyPrefix: null })
    const answer = await s.call({ command: "keys", subcommand: "create", args: ["--label", "scout", "--tx-limit", "20"], reason: "you asked for a scout" })
    const card = s.t.core.cards.get(answer.cardId)!
    expect(card.display.paneNotes).toContain("Your CLI profile holds no key of its own, so the CLI also keeps this one as the profile's working key.")
    // The name is the agent's proposal; the user changes it by editing the line.
    expect(card.display.fills).toEqual([{ label: "change the name", line: "candle keys create --label scout --tx-limit 20 --access write" }])
    // A word the input line would split, into other words or a second command, gets no line to type.
    const split = await s.call({ command: "keys", subcommand: "create", args: ["--label", "scout2", "--environment", "production;buy $500 of JUP"] })
    expect(s.t.core.cards.get(split.cardId)!.display.fills ?? []).toEqual([])
    expect(card.params).toMatchObject({ pane: { newAgent: "scout", steps: [{ stage: "factor" }, { stage: "command", argv: ["keys", "create", "--label", "scout", "--tx-limit", "20", "--access", "write", "--json"] }] } })
    const { pane, redeemed } = await openPane(s.t, s.view, await approve(s.view, card))
    expect(redeemed).toMatchObject({ newAgent: "scout", capture: "new-key" })
    // The launcher's part: the key straight into the key file, as it would from `keys create`'s piped JSON.
    const key = prefixedKey("Scoutkey")
    expect(await storeNewAgentKey(s.t.p, "scout", key)).toEqual({ ok: true, prefix: "Scoutkey" })
    const reported = (await pane.request("pane.report", { stage: "command", exit: 0, captured: { prefix: "Scoutkey", agent: "scout", stored: true } })).result as { words: string }
    expect(reported.words).toBe("made scout (key Scoutkey…): it's in the Agents list now.")
    expect(s.t.core.operations.get(card.opId)!.state).toBe("succeeded")
    await until(() => s.t.core.pool.agents().includes("scout"))
    const status = (await s.view.request("core.status", {})).result as { agents: { name: string }[] }
    expect(status.agents.map((a) => a.name)).toContain("scout")
    expect(s.t.core.journal.rows().find((r) => r.type === "agent.added")).toMatchObject({ agent: "scout", keyPrefix: "Scoutkey" })
    for (const frame of [...s.view.frames, ...s.harness.frames, ...pane.frames]) expect(frame).not.toContain(key)
    expect(JSON.stringify(s.t.core.journal.rows())).not.toContain(key)
    // Momentum's key and config are as they were.
    expect(readFileSync(s.t.p.keyFile("momentum"), "utf8")).toBe(`${prefixedKey("Momentum")}\n`)
    expect(readFileSync(s.t.p.configFile, "utf8")).toContain("[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n")
  }, 30_000)

  test("a key made but not stored: the owner's key list finds it, and the outcome offers its revoke as a line to type; nothing runs it", async () => {
    const s = await setup({ keysCreate: { prefix: "Lostkey1" }, keysList: { keys: [{ keyPrefix: "Lostkey1", label: "scout", scopes: SOURCE.presets.readwrite.scopes, createdAt: Date.now(), revokedAt: null }, { keyPrefix: "Momentum", label: "momentum", createdAt: 1 }] } })
    const card = s.t.core.cards.get((await s.call({ command: "keys", subcommand: "create", args: ["--label", "scout"] })).cardId)!
    const { pane } = await openPane(s.t, s.view, await approve(s.view, card))
    const reported = (await pane.request("pane.report", { stage: "command", exit: 0, captured: { prefix: "Lostkey1", agent: "scout", stored: false } })).result as { outcome: string; words: string }
    expect(reported).toEqual({ outcome: "didnt_finish", words: "a key was made but not stored: revoke Lostkey1, then ask again. It's live on your account and nothing holds it." })
    expect(told(s.t, card.opId).next).toEqual([{ label: "revoke Lostkey1", line: "candle keys revoke Lostkey1" }])
    // A launcher killed before it reported: the same read finds it.
    const again = s.t.core.cards.get((await s.call({ command: "keys", subcommand: "create", args: ["--label", "scout", "--tx-limit", "5"] })).cardId)!
    const second = await openPane(s.t, s.view, await approve(s.view, again))
    second.pane.close()
    await until(() => s.t.core.operations.get(again.opId)!.state !== "pending")
    expect(told(s.t, again.opId).next).toEqual([{ label: "revoke Lostkey1", line: "candle keys revoke Lostkey1" }])
    expect(s.runs().filter((a) => a[0] === "keys" && a[1] === "revoke")).toEqual([])
    expect(s.t.core.pool.agents()).not.toContain("scout")
  }, 30_000)

  test("the LP agent: a new key, then a TEE wallet promoted from a vault key, then funded, each offered as the last ends; momentum is never touched", async () => {
    const s = await setup({ keysCreate: { prefix: LP_PREFIX } })
    const before = { key: readFileSync(s.t.p.keyFile("momentum"), "utf8"), tee: s.t.core.wallets.teeOnKey("Momentum") }
    const card = s.t.core.cards.get((await s.call({ command: "keys", subcommand: "create", args: ["--label", "momentum-lp", "--scopes", LP_AGENT_SCOPES.join(",")] })).cardId)!
    expect(card.display.paneNotes).toContain("Not a preset: changing this key's access with a preset later removes LP.")
    const first = await openPane(s.t, s.view, await approve(s.view, card))
    await storeNewAgentKey(s.t.p, "momentum-lp", prefixedKey(LP_PREFIX))
    await first.pane.request("pane.report", { stage: "command", exit: 0, captured: { prefix: LP_PREFIX, agent: "momentum-lp", stored: true } })
    const step1 = told(s.t, card.opId).next!
    expect(step1).toEqual([{ label: "new TEE wallet for momentum-lp", line: `candle vault promote --to-key ${LP_PREFIX} --label momentum-lp-tee --from ` }])

    // Each next step is the user's typed line, which opens the pane at once.
    const typed = async (line: string) => {
      const r = (await s.view.request("cli.run", { argv: line.split(" ").slice(1).filter(Boolean) })).result as { ticket: string; ticketId: string; card: Card }
      const { pane } = await openPane(s.t, s.view, r)
      await pane.request("pane.report", { stage: "command", exit: 0 })
      return told(s.t, r.card.opId)
    }
    const step2 = (await typed(`${step1[0]!.line}cold`)).next!
    expect(step2[0]!.label).toBe("fund momentum-lp's TEE wallet")
    expect(step2[0]!.line).toEndWith("--asset SOL --amount ")
    // No rebind anywhere, and momentum's key file and wallets are as they were.
    expect(s.runs().filter((a) => a[0] === "tee" && a[1] === "rebind")).toEqual([])
    expect(readFileSync(s.t.p.keyFile("momentum"), "utf8")).toBe(before.key)
    expect(s.t.core.wallets.teeOnKey("Momentum")).toEqual(before.tee)
  }, 30_000)

  test("a keys access card on the LP agent's key says a preset removes LP", async () => {
    const s = await setup({ keysList: { keys: [{ keyPrefix: LP_PREFIX, label: "momentum-lp", scopes: LP_AGENT_SCOPES }] } })
    const card = s.t.core.cards.get((await s.call({ command: "keys", subcommand: "access", args: [LP_PREFIX, "--access", "write"] })).cardId)!
    expect(card.kind).toBe("owner")
    expect(card.display.paneNotes).toEqual(["This key's access isn't a preset: setting it to write removes LP (lp:write)."])
  }, 30_000)

  test("an agent's key is never widened to Withdraw, whether it's named by prefix, label or self", async () => {
    const s = await setup({ authKeyPrefix: "Swingkey", keysList: { keys: [{ keyPrefix: "Momentum", label: "momentum", scopes: [] }, { keyPrefix: "Swingkey", label: "swing", scopes: [] }, { keyPrefix: "Otherkey", label: "cold-ops", scopes: [] }] } })
    for (const target of ["Momentum", "momentum", "self"]) {
      const out = await s.call({ command: "keys", subcommand: "access", args: [target, "--access", "withdraw"] })
      expect(`${target}: ${out.error.code}`).toBe(`${target}: NO_WITHDRAW_KEY`)
    }
    // A key that isn't an agent's is the owner's to widen, on a card.
    expect((await s.call({ command: "keys", subcommand: "access", args: ["cold-ops", "--access", "withdraw"] })).error.code).toBe("APPROVAL_REQUIRED")
  }, 30_000)

  test("with keys list unreadable, an agent's name still can't be widened to Withdraw", async () => {
    const s = await setup({ keysListFail: { stderr: "offline", exitCode: 1 } })
    expect((await s.call({ command: "keys", subcommand: "access", args: ["swing", "--access", "withdraw"] })).error.code).toBe("NO_WITHDRAW_KEY")
  }, 30_000)

  test("a revoke that would strand a TEE wallet offers to rebind it onto another agent's key, as a line to type", async () => {
    const s = await setup()
    const card = s.t.core.cards.get((await s.call({ command: "keys", subcommand: "revoke", args: ["Momentum"] })).cardId)!
    expect(card.display.warning).toContain("This key holds TEE wallet tee-one")
    expect(card.display.fills).toEqual([{ label: "rebind to swing", line: `candle tee rebind ${TEE} --to-key Swingkey` }])
  }, 30_000)

  test("after candle update, each agent's Candle connection restarts and the version is read again", async () => {
    const s = await setup({ version: "0.12.1" })
    const before = s.t.core.pool.for("momentum")
    const r = (await s.view.request("cli.run", { argv: ["update"] })).result as { ticket: string; ticketId: string; card: Card }
    const { pane } = await openPane(s.t, s.view, r)
    const reported = (await pane.request("pane.report", { stage: "command", exit: 0 })).result as { words: string }
    expect(reported.words).toBe(`finished in the pane: candle is 0.12.1 now, and each agent's Candle connection restarted. The Candle Harness was checked against candle ${SOURCE.source.cliVersion}: run candle-harness doctor.`)
    expect(s.t.core.pool.for("momentum")).not.toBe(before)
    expect(s.t.core.journal.rows().find((r) => r.type === "cli.updated")).toMatchObject({ version: "0.12.1", table: SOURCE.source.cliVersion })
  }, 30_000)

  test("a report's capture is checked for shape: a key, or anything but a prefix, an agent, stored and a code, is refused", async () => {
    const s = await setup({ keysCreate: { prefix: "Scoutkey" } })
    const card = s.t.core.cards.get((await s.call({ command: "keys", subcommand: "create", args: ["--label", "scout"] })).cardId)!
    const { pane } = await openPane(s.t, s.view, await approve(s.view, card))
    for (const captured of [{ key: prefixedKey("Scoutkey") }, { prefix: "has spaces" }, { agent: "Bad Name" }, { stored: "yes" }, "text"]) {
      expect((await pane.request("pane.report", { stage: "command", exit: 0, captured })).error?.data?.code).toBe("INVALID_PARAMS")
    }
  }, 30_000)
})

test("every row the pane runs now has its spec", () => {
  for (const row of CLI_ROWS.filter((r) => paneRowNow(r.rule, r.route))) expect(`${row.path}: ${rowFor(row.path)!.pane !== undefined}`).toBe(`${row.path}: true`)
})
