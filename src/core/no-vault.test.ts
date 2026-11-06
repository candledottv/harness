// Owner rows with no vault: the factor drops only where there's no
// vault and the core has never seen one here, and never comes back off. Through a running core, with the
// fake CLI's vault switched between cards; this test process plays the launcher, as cli-owner.test.ts does.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import type { Card } from "./cards"
import { CLI_ROWS, needsVault, unlocksFor } from "./cli-table"
import { FACTOR_ARGV, type PaneResult } from "./pane-plan"
import { NO_VAULT_STEP, VAULT_GONE } from "./vault-mark"

afterAll(() => cleanupHomes())

const TEE = "TeeFake111111111111111111111111111111111111"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})

async function setup(vault: { missing?: boolean; passphrase?: string } = { missing: true }, before?: (stateDir: string) => void) {
  const cliDir = mkdtempSync(join(tmpdir(), "chrn-novault-cli-"))
  const script = (v: typeof vault) => writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ vault: v, authKeyPrefix: "Ownerkey", tee: { wallets: [] } }))
  script(vault)
  const t = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } }, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, ...(before ? { before: (p) => before(p.stateDir) } : {}) })
  cores.push(t)
  const view = await t.view()
  const { client: harness } = await t.harness(view)
  const call = async (args: Record<string, unknown>) => JSON.parse(((await harness.request("tools.call", { name: "candle_cli", args })).result as { content: { text: string }[] }).content[0]!.text)
  const runs = () => (existsSync(join(cliDir, "fake-cli-runs.jsonl")) ? readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv) : [])
  return { t, view, harness, call, runs, vaultIs: script }
}
const approve = async (view: TestClient, card: Card) => (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).result as { ticket: string; ticketId: string; title: string }
async function openPane(t: TestCore, view: TestClient, approved: { ticket: string; ticketId: string }) {
  await view.request("pane.spawned", { ticketId: approved.ticketId, pid: process.pid })
  const { client: pane } = await t.hello(approved.ticket)
  return { pane, redeemed: await pane.request("pane.redeem") }
}
const PRESENT = { passphrase: "pw" }

describe("the table", () => {
  test("rows that need a vault whatever the factor: the ones the CLI unlocks it for, and tee rename; never vault init, status or restore", () => {
    const pane = CLI_ROWS.filter((r) => r.pane !== undefined)
    for (const row of pane) if (unlocksFor(row.path) === "always" && !["vault init", "vault status"].includes(row.path)) expect(`${row.path}: ${needsVault(row)}`).toBe(`${row.path}: true`)
    for (const path of ["vault init", "vault status", "vault restore", "keys create", "keys update", "wallets trust", "auth login"]) expect(`${path}: ${needsVault(pane.find((r) => r.path === path)!)}`).toBe(`${path}: false`)
    expect(needsVault(pane.find((r) => r.path === "tee rename")!)).toBe(true)
  })
})

describe("no vault, and none ever seen here", () => {
  test("an owner row is a card with no factor step that says so, on the card and the pane's header; the pane runs the command alone", async () => {
    const s = await setup()
    const answer = await s.call({ command: "wallets", subcommand: "trust", args: [TEE], reason: "to send to it later" })
    expect(answer.error.code).toBe("APPROVAL_REQUIRED")
    const card = s.t.core.cards.get(answer.cardId)!
    expect(card.display.supported).toBe(true)
    expect(card.display.blocked).toBeUndefined()
    expect(card.display.paneSteps![0]).toStartWith(NO_VAULT_STEP)
    expect(card.params).toMatchObject({ pane: { noVault: true, factorFirst: false, steps: [{ stage: "command", argv: ["wallets", "trust", TEE] }] } })
    const approved = await approve(s.view, card)
    expect(approved.title).toContain(`· ${NO_VAULT_STEP} ·`)
    const { redeemed } = await openPane(s.t, s.view, approved)
    expect(redeemed.result).toMatchObject({ steps: [{ stage: "command", argv: ["wallets", "trust", TEE] }] })
    expect((redeemed.result as { title: string }).title).toContain(NO_VAULT_STEP)
    expect(redeemed.result).toMatchObject({ noVault: true })
    expect(existsSync(s.t.p.vaultSeen)).toBe(false)
  }, 30_000)

  test("typed, the pane opens at once with no factor step: keys create makes the first agent's key with no vault", async () => {
    const s = await setup()
    const r = (await s.view.request("cli.run", { argv: ["keys", "create", "--label", "scout"] })).result as { ticket: string; ticketId: string; card: Card }
    expect(r.ticket).toStartWith("chp_")
    const card = s.t.core.cards.get(r.card.cardId)!
    expect(card.params).toMatchObject({ pane: { noVault: true, newAgent: "scout", steps: [{ stage: "command" }] } })
    const { redeemed } = await openPane(s.t, s.view, r)
    expect((redeemed.result as { steps: { stage: string }[] }).steps.map((x) => x.stage)).toEqual(["command"])
  }, 30_000)

  test("a row that needs a vault by nature keeps its card: vault init in place of approve, typed refused with why", async () => {
    const s = await setup()
    const answer = await s.call({ command: "vault", subcommand: "new-key", args: ["--chain", "solana", "--label", "x-tee"] })
    const card = s.t.core.cards.get(answer.cardId)!
    expect(card.display).toMatchObject({ supported: false, blocked: { fill: { label: "set up a vault", line: "candle vault init" } } })
    expect((await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).error?.data?.code).toBe("NO_VAULT")
    expect((await s.view.request("cli.run", { argv: ["vault", "promote", "--from", "cold", "--to-key", "Momentum"] })).error?.data?.code).toBe("NO_VAULT")
    // vault init and vault restore make one, so they open.
    for (const argv of [["vault", "init"], ["vault", "restore"]]) expect(((await s.view.request("cli.run", { argv })).result as { ticket?: string }).ticket).toStartWith("chp_")
    expect(s.runs().filter((a) => a[0] === "vault" && a[1] !== "status")).toEqual([])
  }, 30_000)
})

describe("the factor comes back on, and stays on", () => {
  test("a vault made between two cards puts the factor on the second, and the core keeps its mark (0600)", async () => {
    const s = await setup()
    const first = s.t.core.cards.get((await s.call({ command: "wallets", subcommand: "trust", args: [TEE] })).cardId)!
    expect(first.params).toMatchObject({ pane: { noVault: true } })
    s.vaultIs(PRESENT)
    const second = s.t.core.cards.get((await s.call({ command: "wallets", subcommand: "allow-launch", args: [TEE] })).cardId)!
    expect((second.params as { pane: { noVault?: true; steps: { stage: string }[] } }).pane.noVault).toBeUndefined()
    expect((second.params as { pane: { steps: { stage: string }[] } }).pane.steps.map((x) => x.stage)).toEqual(["factor", "command"])
    expect(second.display.paneSteps![0]).toStartWith("your vault factor first")
    expect(statSync(s.t.p.vaultSeen).mode & 0o777).toBe(0o600)
    expect(s.t.core.journal.rows().filter((r) => r.type === "vault.seen")).toHaveLength(1)
  }, 30_000)

  test("a vault made between a card and its pane puts the factor on that pane, and the header no longer says no vault", async () => {
    const s = await setup()
    const card = s.t.core.cards.get((await s.call({ command: "wallets", subcommand: "trust", args: [TEE] })).cardId)!
    const approved = await approve(s.view, card)
    s.vaultIs(PRESENT)
    const { redeemed } = await openPane(s.t, s.view, approved)
    const r = redeemed.result as { steps: { stage: string; argv: string[] }[]; title: string }
    expect(r.steps).toEqual([{ stage: "factor", argv: [...FACTOR_ARGV] }, { stage: "command", argv: ["wallets", "trust", TEE] }])
    expect(r.title).not.toContain(NO_VAULT_STEP)
    expect((redeemed.result as { noVault?: boolean }).noVault).toBeUndefined()
    expect(s.t.core.journal.rows().find((x) => x.type === "pane.factor_added")).toMatchObject({ opId: card.opId, vault: "present" })
    expect(existsSync(s.t.p.vaultSeen)).toBe(true)
  }, 30_000)

  test("the mark and no vault: owner rows are refused naming vault restore, from the agent and typed; a no-vault card's pane is refused too", async () => {
    const s = await setup()
    const early = s.t.core.cards.get((await s.call({ command: "wallets", subcommand: "trust", args: [TEE] })).cardId)!
    const approved = await approve(s.view, early)
    // The vault appears (and is marked), then goes.
    s.vaultIs(PRESENT)
    await s.call({ command: "wallets", subcommand: "allow-launch", args: [TEE] })
    s.vaultIs({ missing: true })
    const answer = await s.call({ command: "keys", subcommand: "create", args: ["--label", "scout"] })
    expect(answer.error).toMatchObject({ code: "VAULT_GONE", message: VAULT_GONE })
    expect(answer.error.message).toContain("candle vault restore")
    expect((await s.view.request("cli.run", { argv: ["keys", "update", "Momentum", "--embedded-wallet", "allow"] })).error?.data?.code).toBe("VAULT_GONE")
    const { redeemed } = await openPane(s.t, s.view, approved)
    expect(redeemed.error?.data?.code).toBe("VAULT_GONE")
    await until(() => s.t.core.operations.get(early.opId)?.state === "refused")
    expect((s.t.core.operations.get(early.opId)!.result as { pane: PaneResult }).pane.words).toContain("candle vault restore")
    expect(s.runs().filter((a) => a[0] === "wallets" || a[0] === "keys")).toEqual([])
  }, 30_000)

  test("forget vault is the person's own: never the agent's, refused while there's a vault, and after it owner rows run with no factor again", async () => {
    const s = await setup(PRESENT)
    await s.call({ command: "wallets", subcommand: "trust", args: [TEE] })
    expect(existsSync(s.t.p.vaultSeen)).toBe(true)
    expect((await s.harness.request("vault.forget", {})).error?.code).toBe(-32001)
    expect((await s.view.request("vault.forget", {})).error?.data?.code).toBe("VAULT_PRESENT")
    expect(existsSync(s.t.p.vaultSeen)).toBe(true)
    s.vaultIs({ missing: true })
    expect((await s.call({ command: "wallets", subcommand: "trust", args: [TEE] })).error.code).toBe("VAULT_GONE")
    const popped = await s.t.view("candle-harness view --pane wallets")
    expect((await popped.request("vault.forget", {})).error?.data?.code).toBe("MAIN_VIEW_ONLY")
    expect(((await s.view.request("vault.forget", {})).result as { said: string }).said).toStartWith("Forgotten")
    expect(existsSync(s.t.p.vaultSeen)).toBe(false)
    expect(s.t.core.journal.rows().find((r) => r.type === "vault.forgotten")).toBeDefined()
    // A different row: the first card, made with the vault, is still waiting and keeps its factor.
    const card = s.t.core.cards.get((await s.call({ command: "wallets", subcommand: "allow-launch", args: [TEE] })).cardId)!
    expect(card.params).toMatchObject({ pane: { noVault: true } })
  }, 30_000)

  test("a mark left from before a restart still holds", async () => {
    const s = await setup({ missing: true }, (stateDir) => writeFileSync(join(stateDir, "vault-seen.json"), `${JSON.stringify({ seenAt: "2026-10-01T00:00:00.000Z" })}\n`, { mode: 0o600 }))
    expect((await s.call({ command: "wallets", subcommand: "trust", args: [TEE] })).error.code).toBe("VAULT_GONE")
  }, 30_000)
})
