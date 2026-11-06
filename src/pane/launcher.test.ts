// The prompt pane end to end: a core, the launcher in a real PTY as the view starts it,
// and the fake CLI at a hidden prompt. The test plays the view: it approves, starts the launcher with the
// ticket, names its pid, and types into the pane.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_KEY, cleanupHomes, fakeCandle, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import { rowFor } from "../core/cli-table"
import { paths } from "../paths"
import { candleEnv, captureOf, PANE_SOCKET_ENV, PANE_TICKET_ENV, refusalWords } from "./launcher"
import { paneEnv } from "../view/pane-process"

const MAIN = join(import.meta.dir, "../main.ts")
const TEE = "TeeFake111111111111111111111111111111111111"
const PASS = "correct horse battery staple"
const PHRASE = Array.from({ length: 24 }, (_, i) => `canaryword${i}`).join(" ")
// Made up, and built at run time: the scrub refuses key literals.
const CANARY_KEY = `${["cndl", "live", ""].join("_")}Canary${"k".repeat(37)}`

const dirs: string[] = []
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  cleanupHomes()
})

/** A CLI config folder holding the fake CLI's script, as CANDLE_CONFIG_DIR. */
function cliDir(script: Record<string, unknown>): string {
  const dir = mkdtempSync("/tmp/chrn-cli-")
  dirs.push(dir)
  writeFileSync(join(dir, "fake-cli.json"), JSON.stringify(script))
  return dir
}

const runs = (dir: string): { argv: string[]; env: Record<string, string>; fds?: { fd: number; target: string }[]; tty: { stdin: boolean; stdout: boolean } }[] => {
  try {
    return readFileSync(join(dir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function setup(): Promise<{ c: TestCore; view: TestClient; viewId: string }> {
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  const viewId = (c.core.server.clients().find((x) => x.role === "view")?.clientId)!
  return { c, view, viewId }
}

interface Pane {
  proc: Bun.Subprocess
  screen(): string
  type(text: string): void
}

/** Starts the launcher as the view does: in a PTY, the ticket and socket in its environment, then pane.spawned. */
async function openPane(c: TestCore, view: TestClient, opened: { ticket: string; ticketId: string }, env: Record<string, string>, opts: { name?: boolean } = {}): Promise<Pane> {
  let out = ""
  const decoder = new TextDecoder()
  const proc = Bun.spawn([process.execPath, MAIN, "cli-pane"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", TERM: "xterm-256color", ...env, [PANE_TICKET_ENV]: opened.ticket, [PANE_SOCKET_ENV]: c.p.socket },
    terminal: { cols: 100, rows: 30, data: (_t, chunk) => void (out += decoder.decode(chunk, { stream: true })) },
  })
  if (opts.name !== false) expect((await view.request("pane.spawned", { ticketId: opened.ticketId, pid: proc.pid })).result).toEqual({ ok: true })
  return { proc, screen: () => out, type: (text) => void proc.terminal!.write(text) }
}

/** A typed line the user ran that opens the pane: a card inside, approved as "typed". */
async function typed(view: TestClient, argv: string[]): Promise<{ ticket: string; ticketId: string; card: { cardId: string; opId: string; approvedHow: string } }> {
  const answer = await view.request("cli.run", { argv })
  if (answer.error) throw new Error(JSON.stringify(answer.error))
  const r = answer.result as { kind: string; ticket: string; ticketId: string; card: { cardId: string; opId: string; approvedHow: string } }
  expect(r.kind).toBe("pane")
  return r
}

const opState = (c: TestCore, opId: string) => c.core.operations.get(opId)?.state
const paneWords = (c: TestCore, opId: string) => (c.core.operations.get(opId)?.result as { pane?: { outcome: string; words: string } } | undefined)?.pane

describe("a typed row that asks at the CLI's own prompt", () => {
  test("tee fund: the pane opens at once, the user types the passphrase there, and it finishes", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    expect(opened.card.approvedHow).toBe("typed")
    expect(opState(c, opened.card.opId)).toBe("pending")
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase (input hidden):"))
    pane.type(`${PASS}\r`)
    expect(await pane.proc.exited).toBe(0)
    expect(pane.screen()).toContain(`Send SOL to ${TEE}`)
    expect(pane.screen()).toContain("Finished in the pane.")
    expect(opState(c, opened.card.opId)).toBe("succeeded")
    expect(paneWords(c, opened.card.opId)?.outcome).toBe("finished")
    // An owner row: no key went to candle, and it ran on the pane's terminal.
    const ran = runs(dir).find((r) => r.argv[0] === "tee")!
    expect(ran.argv).toEqual(["tee", "fund", TEE, "--amount", "0.001"])
    expect(ran.env.CANDLE_API_KEY).toBeUndefined()
    expect(ran.tty).toEqual({ stdin: true, stdout: true })
  }, 20_000)

  test("exit 1, 2 and 3 each have their words; nothing is re-sent", async () => {
    for (const [exit, outcome, state] of [
      [1, "didnt_finish", "failed"],
      [2, "usage", "failed"],
      [3, "pending", "unknown"],
    ] as const) {
      const { c, view } = await setup()
      const dir = cliDir({ vault: { passphrase: PASS }, paneOutcome: exit })
      const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
      const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
      await until(() => pane.screen().includes("Vault passphrase"))
      pane.type(`${PASS}\r`)
      await pane.proc.exited
      expect(`${exit}: ${paneWords(c, opened.card.opId)?.outcome}`).toBe(`${exit}: ${outcome}`)
      expect(opState(c, opened.card.opId)).toBe(state)
      if (exit === 2) expect(c.core.journal.rows().some((r) => r.type === "pane.usage")).toBe(true)
      if (exit === 3) {
        expect(pane.screen()).toContain("may still land")
        expect((await view.request("operations.resolve", { opId: opened.card.opId, action: "resend" })).error?.data?.code).toBe("NO_RESEND")
      }
      expect(runs(dir).filter((r) => r.argv[0] === "tee")).toHaveLength(1)
      await c.close()
      cores.splice(cores.indexOf(c), 1)
    }
  }, 45_000)

  test("a wrong passphrase: the CLI refuses, the step didn't finish", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type("wrong\r")
    await pane.proc.exited
    expect(pane.screen()).toContain("Could not open the vault")
    expect(paneWords(c, opened.card.opId)?.outcome).toBe("didnt_finish")
  }, 20_000)
})

describe("Ctrl-C and a closed pane", () => {
  test("Ctrl-C at the hidden prompt reaches nothing; the view's stop (SIGUSR1) ends candle, and the outcome is stopped", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type("\x03")
    await Bun.sleep(300)
    // As at the real CLI: still at the prompt, the launcher too.
    expect(pane.proc.exitCode).toBeNull()
    expect(opState(c, opened.card.opId)).toBe("pending")
    pane.proc.kill("SIGUSR1")
    expect(await pane.proc.exited).toBe(0)
    expect(paneWords(c, opened.card.opId)).toMatchObject({ outcome: "stopped", signal: "SIGTERM" })
    expect(opState(c, opened.card.opId)).toBe("failed")
    expect(pane.screen()).toContain("Stopped in the pane")
  }, 20_000)

  test("the pane closed mid-run (a hangup): candle is ended, and the outcome is stopped", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS }, paneOutcome: "sleep" })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await until(() => runs(dir).some((r) => r.argv[0] === "tee"))
    await Bun.sleep(200)
    pane.proc.kill("SIGHUP")
    await pane.proc.exited
    await until(() => opState(c, opened.card.opId) !== "pending")
    expect(paneWords(c, opened.card.opId)?.outcome).toBe("stopped")
  }, 20_000)

  test("a launcher killed outright never reports: the outcome is unknown, for the user to check", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.proc.kill("SIGKILL")
    await until(() => opState(c, opened.card.opId) !== "pending")
    expect(opState(c, opened.card.opId)).toBe("unknown")
    expect(paneWords(c, opened.card.opId)?.outcome).toBe("unknown")
  }, 20_000)
})

describe("the agent's card", () => {
  test("tee disable from the agent: a card; approving it opens the pane with the agent's key, and the agent learns only the outcome", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const { client: harness } = await c.harness(view)
    const second = await c.view()
    await second.request("subscribe", { topics: ["cards", "operations", "activity"] })
    await view.request("subscribe", { topics: ["cards", "operations", "activity", "agent"] })
    const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [TEE] } })
    const body = JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text)
    expect(body.error.code).toBe("APPROVAL_REQUIRED")
    const card = c.core.cards.get(body.cardId)!
    expect(card.route).toBe("pane")
    expect(card.display.headline).toBe("LESS ACCESS · candle tee disable TeeF…1111")
    expect(card.display.title).toBe(`LESS ACCESS · candle tee disable ${TEE}`)
    expect(card.display.paneNote).toContain("can't see")
    const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "click" })).result as { kind: string; ticket: string; ticketId: string }
    expect(approved.kind).toBe("pane")
    const pane = await openPane(c, view, approved, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await pane.proc.exited
    expect(opState(c, card.opId)).toBe("succeeded")
    const ran = runs(dir).find((r) => r.argv[0] === "tee")!
    expect(ran.env.CANDLE_API_KEY).toBe(AGENT_KEY)
    // The ticket went to the approving view only; the key to no view at all.
    expect(view.frames.filter((f) => f.includes(approved.ticket))).toHaveLength(1)
    expect(second.frames.some((f) => f.includes(approved.ticket))).toBe(false)
    for (const frame of [...view.frames, ...second.frames, ...harness.frames]) expect(frame).not.toContain(AGENT_KEY)
    // Activity, and so the agent's record, says how it ended in the pane's words: a stop is for good (a stopped TEE wallet is never re-enabled).
    await until(() => view.events.some((e) => e.topic === "activity" && JSON.stringify(e.data).includes("stopped for good")))
  }, 20_000)
})

describe("the canary: nothing the pane shows leaves it", () => {
  test("a made-up phrase and key printed on the pane are nowhere in the core's messages, the journal, the agent's events or a view", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS }, paneOutcome: "canary", canary: { phrase: PHRASE, key: CANARY_KEY } })
    await view.request("subscribe", { topics: ["status", "cards", "operations", "activity", "agent", "portfolio", "wallets"] })
    const { client: harness } = await c.harness(view)
    await harness.request("subscribe", { topics: ["cards", "operations"] })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await pane.proc.exited
    // It was on the pane...
    expect(pane.screen()).toContain(PHRASE)
    expect(pane.screen()).toContain(CANARY_KEY)
    // ...and nowhere else. The passphrase typed there neither.
    const journal = readFileSync(c.p.journal, "utf8")
    for (const secret of [PHRASE, "canaryword7", CANARY_KEY, PASS]) {
      expect(journal).not.toContain(secret)
      for (const frame of [...view.frames, ...harness.frames]) expect(frame).not.toContain(secret)
    }
  }, 20_000)
})

describe("the factor step and paths (an owner row, as the core proposes it)", () => {
  /** Proposes a pane card directly, as the owner rows will, and approves it from the view. */
  async function ownerCard(c: TestCore, view: TestClient, viewId: string, path: string, words: string[]) {
    const card = await c.core.cards.propose({
      client: { clientId: viewId, role: "view", agent: "momentum" },
      agent: "momentum",
      tool: "candle_cli",
      args: { cli: words },
      params: { cli: words },
      kind: "owner",
      idKey: "coreOpId",
      pane: { row: rowFor(path)!, rule: "owner", identity: "owner", words, rpcUrl: false },
    })
    await Bun.sleep(5)
    const r = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "click" })).result as { kind: string; ticket: string; ticketId: string }
    expect(r.kind).toBe("pane")
    return { card, opened: r }
  }

  test("the factor passes, then the command runs, its stdout piped for a capture row", async () => {
    const { c, view, viewId } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const { card, opened } = await ownerCard(c, view, viewId, "keys create", ["keys", "create", "--name", "pane-test"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await pane.proc.exited
    const ran = runs(dir)
    expect(ran.map((r) => r.argv.slice(0, 3).join(" "))).toEqual(["vault status --unlock", "keys create --name"])
    // The factor step's stdout is piped; so is the capture row's.
    expect(ran[0]!.tty).toEqual({ stdin: true, stdout: false })
    expect(ran[1]!.tty).toEqual({ stdin: true, stdout: false })
    expect(ran[1]!.argv).toContain("--json")
    expect(opState(c, card.opId)).toBe("succeeded")
  }, 20_000)

  test("a wrong passphrase at the factor step runs nothing", async () => {
    const { c, view, viewId } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const { card, opened } = await ownerCard(c, view, viewId, "keys create", ["keys", "create", "--name", "pane-test"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type("nope\r")
    await pane.proc.exited
    expect(runs(dir).map((r) => r.argv[0])).toEqual(["vault"])
    expect(paneWords(c, card.opId)).toMatchObject({ outcome: "refused_before", code: "VAULT_UNLOCK_FAILED" })
    expect(opState(c, card.opId)).toBe("refused")
    expect(pane.screen()).toContain("The passphrase didn't open the vault. Nothing was run.")
  }, 20_000)

  test("only ok: true unlocks: an exit 0 with nothing written runs nothing", async () => {
    const { c, view, viewId } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS, silentExit0: true } })
    const { card, opened } = await ownerCard(c, view, viewId, "keys create", ["keys", "create", "--name", "pane-test"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await pane.proc.exited
    expect(runs(dir).map((r) => r.argv[0])).toEqual(["vault"])
    expect(paneWords(c, card.opId)?.outcome).toBe("refused_before")
  }, 20_000)

  test("no vault: VAULT_MISSING, nothing runs, and the words say candle vault init", async () => {
    const { c, view, viewId } = await setup()
    const dir = cliDir({ vault: { missing: true } })
    const { card, opened } = await ownerCard(c, view, viewId, "keys create", ["keys", "create", "--name", "pane-test"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await pane.proc.exited
    expect(runs(dir)).toHaveLength(1)
    expect(paneWords(c, card.opId)).toMatchObject({ outcome: "refused_before", code: "VAULT_MISSING" })
    expect(pane.screen()).toContain("candle vault init")
  }, 20_000)

  test("Ctrl-C at the factor step: stopped, and nothing runs", async () => {
    const { c, view, viewId } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const { card, opened } = await ownerCard(c, view, viewId, "keys create", ["keys", "create", "--name", "pane-test"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type("\x03")
    await Bun.sleep(200)
    pane.proc.kill("SIGUSR1")
    await pane.proc.exited
    expect(runs(dir)).toHaveLength(1)
    expect(paneWords(c, card.opId)).toMatchObject({ outcome: "stopped" })
    expect(pane.screen()).toContain("Nothing was run")
  }, 20_000)

  test("a path the agent may not give is asked in the pane and goes on the command line only", async () => {
    const { c, view, viewId } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const { card, opened } = await ownerCard(c, view, viewId, "vault backup", ["vault", "backup"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Where to write the backup"))
    pane.type("/tmp/backup-from-the-pane.json\r")
    await pane.proc.exited
    const ran = runs(dir)
    expect(ran.at(-1)!.argv).toEqual(["vault", "backup", "--to", "/tmp/backup-from-the-pane.json"])
    expect(opState(c, card.opId)).toBe("succeeded")
    expect(readFileSync(c.p.journal, "utf8")).not.toContain("backup-from-the-pane")
  }, 20_000)

  test("Ctrl-C at a path backs out: stopped, nothing runs", async () => {
    const { c, view, viewId } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const { card, opened } = await ownerCard(c, view, viewId, "vault backup", ["vault", "backup"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Where to write the backup"))
    pane.type("/tmp/x\x03")
    await pane.proc.exited
    expect(runs(dir)).toHaveLength(0)
    expect(paneWords(c, card.opId)?.outcome).toBe("stopped")
  }, 20_000)
})

describe("no vault on the machine", () => {
  test("a typed owner row runs with no factor step, and the pane says so before the command", async () => {
    const dir = cliDir({ vault: { missing: true } })
    const c = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: dir } })
    cores.push(c)
    const view = await c.view()
    const TEE = "TeeFake111111111111111111111111111111111111"
    const opened = await typed(view, ["wallets", "trust", TEE])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await pane.proc.exited
    // Wrapped at spaces to the pane's width, so read as one line.
    expect(pane.screen().replace(/\r*\n/g, " ")).toContain("No vault on this machine, so there's no factor to ask for: you approve this here, and the agent can't type in this pane.")
    // The core read the CLI's version and the vault when the card was made, and the vault again as the pane started; the pane ran the command alone.
    expect(runs(dir).map((r) => r.argv.slice(0, 2).join(" "))).toEqual(["--version", "vault status", "vault status", "wallets trust"])
    expect(runs(dir).some((r) => r.argv.includes("--unlock"))).toBe(false)
  }, 20_000)
})

describe("the RPC from config", () => {
  test("reaches the pane's candle in its environment, never on a command line other users can read", async () => {
    const RPC = "https://rpc.example.test/secret-path-token/"
    const dir = cliDir({ vault: { missing: true } })
    const candle = await fakeCandle()
    const c = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: dir } }, { config: { candle: { mcp: { route: "cli", path: "candle-mcp" }, cliPath: candle, rpcUrl: RPC, profile: undefined } } })
    cores.push(c)
    const view = await c.view()
    const opened = await typed(view, ["tee", "status", TEE, "--verify"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await pane.proc.exited
    const ran = runs(dir).find((r) => r.argv[0] === "tee")!
    expect(ran.argv).toEqual(["tee", "status", TEE, "--verify"])
    expect(ran.env.CANDLE_SOLANA_RPC_URL).toBe(RPC)
  }, 20_000)
})

describe("the plan's renewal", () => {
  test("a typed row opens with no card, so the pane says the CLI renews the plan first, before the command runs", async () => {
    const dir = cliDir({ vault: { missing: true } })
    mkdirSync(join(dir, "spend"), { recursive: true })
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(join(dir, "spend", "default.plan.json"), JSON.stringify({ autoRenew: true, plan: "max", payer: "PayerFake1", periodEnd: end, renewCeilingRaw: "200000000" }))
    const c = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: dir } })
    cores.push(c)
    const view = await c.view()
    const opened = await typed(view, ["wallets", "trust", TEE])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await pane.proc.exited
    expect(pane.screen().replace(/\r*\n/g, " ")).toContain(`Your Candle Max plan renews first: auto-renew is on and it ends ${end.slice(0, 10)}`)
  }, 20_000)
})

describe("the pane's environment", () => {
  test("0.2's CANDLE_TUI_* variables are stripped as ours are, by the view and again by the launcher", () => {
    const env = { CANDLE_TUI_HOME: "/old/home", CANDLE_TUI_TEST_KEY_FILE: "/old/key", CANDLE_HARNESS_HOME: "/new/home", CANDLE_API_KEY: "k", CANDLE_DEVICE_TOKEN: "d", CANDLE_KEYRING_PASSPHRASE: "p", CANDLE_CONFIG_DIR: "/cli", PATH: "/bin" }
    const viewSide = paneEnv(env, { ticket: "t", socketPath: "/s" })
    for (const name of Object.keys(viewSide)) expect(/^CANDLE_TUI_/.test(name)).toBe(false)
    expect(viewSide.CANDLE_HARNESS_HOME).toBeUndefined()
    expect(viewSide.CANDLE_KEYRING_PASSPHRASE).toBe("p")
    const launched = candleEnv(env, { identity: "owner" })
    expect(Object.keys(launched).filter((n) => /^CANDLE_(TUI|HARNESS)_|^CANDLE_API_KEY$|^CANDLE_DEVICE_TOKEN$/.test(n))).toEqual([])
    expect(launched.CANDLE_CONFIG_DIR).toBe("/cli")
    expect(launched.CANDLE_KEYRING_PASSPHRASE).toBe("p")
  })

  test("stripped: no ticket, no socket, none of ours, no device token; the agent's key only for its row; login variables, the CLI's config folder and the person's keyring passphrase kept", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const { client: harness } = await c.harness(view)
    const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [TEE] } })
    const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
    const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "click" })).result as { ticket: string; ticketId: string }
    const pane = await openPane(c, view, approved, {
      CANDLE_CONFIG_DIR: dir,
      CANDLE_HARNESS_HOME: "/should/not/pass",
      CANDLE_DEVICE_TOKEN: "dvc-should-not-pass",
      CANDLE_KEYRING_PASSPHRASE: "the-person's-own",
      CANDLE_API_KEY: "a-key-the-view-had",
      USER: "unknown",
      LOGNAME: "",
    })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await pane.proc.exited
    const env = runs(dir).find((r) => r.argv[0] === "tee")!.env
    for (const name of Object.keys(env)) expect(name.startsWith("CANDLE_HARNESS_")).toBe(false)
    expect(JSON.stringify(env)).not.toContain(approved.ticket)
    expect(env.CANDLE_DEVICE_TOKEN).toBeUndefined()
    expect(env.CANDLE_KEYRING_PASSPHRASE).toBe("the-person's-own")
    expect(env.CANDLE_API_KEY).toBe(AGENT_KEY)
    expect(env.CANDLE_NO_UPDATE_NOTIFIER).toBe("1")
    expect(env.CANDLE_CONFIG_DIR).toBe(dir)
    expect(env.USER).not.toBe("unknown")
    expect(env.LOGNAME).toBe(env.USER)
    // The launcher's own command line never held the ticket.
    expect(runs(dir).every((r) => !r.argv.join(" ").includes(approved.ticket))).toBe(true)
  }, 20_000)

  test("no descriptor above 2 reaches candle: the core's socket isn't inherited", async () => {
    if (process.platform !== "linux") return
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await pane.proc.exited
    const fds = runs(dir).find((r) => r.argv[0] === "tee")!.fds!
    expect(fds.map((f) => f.fd)).toContain(2)
    expect(fds.filter((f) => f.target.startsWith("socket:") || f.target.includes(c.p.stateDir))).toEqual([])
  }, 20_000)
})

describe("the ticket", () => {
  test("refused from a process the view didn't name, and to a view or a harness", async () => {
    const { c, view } = await setup()
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    await view.request("pane.spawned", { ticketId: opened.ticketId, pid: 999_999 })
    // This process isn't pid 999999: its hello is refused, and closes.
    const { response, client } = await c.hello(opened.ticket)
    expect(response.error?.data?.code).toBe("UNAUTHENTICATED")
    await client.closed
    // A view and a harness may not redeem or report.
    expect((await view.request("pane.redeem", {})).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    const { client: harness } = await c.harness(view)
    expect((await harness.request("pane.redeem", {})).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    expect((await harness.request("pane.spawned", { ticketId: opened.ticketId, pid: 5 })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  })

  test("only the approving view names the pid", async () => {
    const { c, view } = await setup()
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    const other = await c.view()
    expect((await other.request("pane.spawned", { ticketId: opened.ticketId, pid: 1234 })).error?.data?.code).toBe("TICKET_NOT_FOUND")
  })

  test("redeemed once: a second launcher with the same ticket is refused", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    const first = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    await until(() => first.screen().includes("Vault passphrase"))
    const again = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir }, { name: false })
    expect(await again.proc.exited).toBe(1)
    expect(again.screen()).toContain("Nothing was run")
    first.type(`${PASS}\r`)
    await first.proc.exited
  }, 20_000)

  test("a card changed after approval is refused at redeem, and nothing runs", async () => {
    const { c, view } = await setup()
    const dir = cliDir({ vault: { passphrase: PASS } })
    const opened = await typed(view, ["tee", "fund", TEE, "--amount", "0.001"])
    // Something swaps the step under the card: the hash no longer holds.
    const card = c.core.cards.get(opened.card.cardId)!
    ;(card.params as { pane: { steps: { argv: string[] }[] } }).pane.steps[0]!.argv = ["tee", "fund", TEE, "--amount", "999"]
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir })
    expect(await pane.proc.exited).toBe(1)
    expect(runs(dir)).toHaveLength(0)
    expect(paneWords(c, opened.card.opId)).toMatchObject({ outcome: "refused_before", code: "CARD_CHANGED" })
  }, 20_000)
})

describe("keys create through the real launcher", () => {
  test("the agent's card; the factor, then the key straight into the key file, never on the pane; the core loads the agent", async () => {
    const dir = cliDir({ vault: { passphrase: PASS }, keysCreate: { prefix: "Scoutkey" }, authKeyPrefix: "Ownerkey" })
    const c = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: dir } })
    cores.push(c)
    const view = await c.view()
    const { client: harness } = await c.harness(view)
    const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "keys", subcommand: "create", args: ["--label", "scout"] } })
    const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
    const opened = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).result as { ticket: string; ticketId: string }
    // As the view starts it: no CANDLE_HARNESS_HOME (the pane's environment drops ours), and a HOME of its own.
    const paneHome = mkdtempSync(join(tmpdir(), "chrn-panehome-"))
    dirs.push(paneHome)
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir, HOME: paneHome })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    expect(await pane.proc.exited).toBe(0)
    const key = prefixedKey("Scoutkey").replace(/x/g, "k")
    expect(readFileSync(c.p.keyFile("scout"), "utf8")).toBe(`${key}\n`)
    expect(pane.screen()).toContain("Made key Scoutkey… and stored it as scout.")
    expect(pane.screen()).toContain("Made scout (key Scoutkey…): it's in the Agents list now.")
    expect(pane.screen()).not.toContain(key)
    expect(existsSync(join(paneHome, ".config"))).toBe(false)
    await until(() => c.core.pool.agents().includes("scout"))
    for (const frame of [...view.frames, ...harness.frames]) expect(frame).not.toContain(key)
    expect(JSON.stringify(c.core.journal.rows())).not.toContain(key)
  }, 30_000)
  test("a new account's wallet not authorized: the pane says Candle's words, setup's facts say so, and the next try clears it", async () => {
    const dir = cliDir({ vault: { passphrase: PASS }, keysCreate: { prefix: "Scoutkey", refuse: { code: "AGENT_WALLET_NOT_DELEGATED", status: 403, message: "solana wallet is not delegated; delegate at least one wallet before issuing an agent key" } }, authKeyPrefix: "Ownerkey" })
    const c = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: dir } })
    cores.push(c)
    const view = await c.view()
    const opened = await typed(view, ["keys", "create", "--label", "scout"])
    const paneHome = mkdtempSync(join(tmpdir(), "chrn-panehome-"))
    dirs.push(paneHome)
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir, HOME: paneHome })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    expect(await pane.proc.exited).toBe(0)
    expect(pane.screen()).toContain("The CLI said:")
    expect(pane.screen()).toContain("AGENT_WALLET_NOT_DELEGATED: solana wallet is not delegated")
    expect(pane.screen()).toContain("this account hasn't authorized its embedded wallet for agents")
    expect(existsSync(c.p.keyFile("scout"))).toBe(false)
    expect(c.core.journal.rows().some((r) => r.type === "agent.key_not_stored")).toBe(false)
    expect(((await view.request("onboarding.get", {})).result as { facts: { keyRefused?: string } }).facts.keyRefused).toBe("AGENT_WALLET_NOT_DELEGATED")
    // The next try clears it, whatever it then finds.
    await view.request("cli.run", { argv: ["keys", "create", "--label", "scout"] })
    expect(((await view.request("onboarding.get", {})).result as { facts: { keyRefused?: string } }).facts.keyRefused).toBeUndefined()
  }, 30_000)

  test("a prefix with - and _ is stored and loaded, and a second keys create waits for the first", async () => {
    const dir = cliDir({ vault: { passphrase: PASS }, keysCreate: { prefix: "Sc-ut_ky" }, authKeyPrefix: "Ownerkey" })
    const c = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: dir } })
    cores.push(c)
    const view = await c.view()
    const opened = await typed(view, ["keys", "create", "--label", "scout"])
    // Setup's "Make the key" pressed again while the first pane is open: refused, nothing run.
    const again = await view.request("cli.run", { argv: ["keys", "create", "--label", "scout"] })
    expect(again.error?.data?.code).toBe("KEY_BEING_MADE")
    const paneHome = mkdtempSync(join(tmpdir(), "chrn-panehome-"))
    dirs.push(paneHome)
    const pane = await openPane(c, view, opened, { CANDLE_CONFIG_DIR: dir, HOME: paneHome })
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    expect(await pane.proc.exited).toBe(0)
    expect(pane.screen()).toContain("Made key Sc-ut_ky… and stored it as scout.")
    expect(pane.screen()).toContain("Made scout (key Sc-ut_ky…): it's in the Agents list now.")
    expect(pane.screen()).not.toContain("not stored")
    await until(() => c.core.pool.agents().includes("scout"))
    expect(c.core.journal.rows().some((r) => r.type === "agent.key_not_stored")).toBe(false)
  }, 30_000)
})

describe("a capture row's reading", () => {
  const made = (prefix: string, extra: Record<string, unknown> = {}) => JSON.stringify({ key: prefixedKey(prefix), keyPrefix: prefix, scopes: ["swap:write"], environment: "live", embeddedWallet: "denied", stored: false, ...extra })

  test("keys create: the key goes into the key file as the card's agent; only its prefix, the agent and stored come back", async () => {
    const home = mkdtempSync(join(tmpdir(), "chrn-cap-"))
    const env = { CANDLE_HARNESS_HOME: home }
    const captured = await captureOf({ capture: "new-key", newAgent: "scout", home }, `${made("Scoutkey")}\n`)
    expect(captured).toEqual({ agent: "scout", stored: true, prefix: "Scoutkey" })
    expect(readFileSync(paths(env).keyFile("scout"), "utf8")).toBe(`${prefixedKey("Scoutkey")}\n`)
    // The CLI's own store failing (exit 1) still printed the key: it's stored all the same.
    expect(await captureOf({ capture: "new-key", newAgent: "scout2", home }, made("Scout2ky", { storeError: "keychain locked" }))).toEqual({ agent: "scout2", stored: true, prefix: "Scout2ky" })
    // An agent already here keeps its key: the new one is reported made, not stored.
    expect(await captureOf({ capture: "new-key", newAgent: "scout", home }, made("Another1"))).toEqual({ agent: "scout", stored: false, prefix: "Another1" })
    expect(readFileSync(paths(env).keyFile("scout"), "utf8")).toBe(`${prefixedKey("Scoutkey")}\n`)
    // Nothing parsed, nothing captured.
    expect(await captureOf({ capture: "new-key", newAgent: "scout3", home }, "API key: not json\n")).toBeUndefined()
    expect(existsSync(paths(env).keyFile("scout3"))).toBe(false)
    // No home from the core, nowhere to store: never a guess from the pane's own environment.
    expect(await captureOf({ capture: "new-key", newAgent: "scout4" }, made("Scout4ky"))).toBeUndefined()
  })

  test("a new account's refusal goes back as its code, so setup can say what to do", async () => {
    const home = mkdtempSync(join(tmpdir(), "chrn-cap-"))
    const said = "solana wallet So1… is not delegated and hood wallet 0x… is not delegated; delegate at least one wallet before issuing an agent key"
    expect(await captureOf({ capture: "new-key", newAgent: "scout", home }, JSON.stringify({ ok: false, code: "AGENT_WALLET_NOT_DELEGATED", status: 403, message: said }))).toEqual({ agent: "scout", stored: false, code: "AGENT_WALLET_NOT_DELEGATED" })
    // A bare HTTP code with Candle's words is read by the words.
    expect(await captureOf({ capture: "new-key", newAgent: "scout", home }, JSON.stringify({ ok: false, code: "HTTP_403", status: 403, message: said }))).toEqual({ agent: "scout", stored: false, code: "AGENT_WALLET_NOT_DELEGATED" })
    expect(await captureOf({ capture: "new-key", newAgent: "scout", home }, JSON.stringify({ ok: false, code: "VALIDATION_FAILED", status: 403, message: "Active key limit reached (max 12 active keys)" }))).toEqual({ agent: "scout", stored: false, code: "VALIDATION_FAILED" })
    expect(existsSync(paths({ CANDLE_HARNESS_HOME: home }).keyFile("scout"))).toBe(false)
  })

  test("a refusal in --json is said in the pane's words, not swallowed; a key never is", () => {
    const refused = { ok: false, code: "KEY_LIMIT", message: "This account has 12 active keys.", suggestion: "Revoke one with candle keys revoke <prefix>." }
    expect(refusalWords(refused)).toBe("KEY_LIMIT: This account has 12 active keys. Revoke one with candle keys revoke <prefix>.")
    expect(refusalWords({ ok: false, message: "line one\nline two\u001b[31m" })).toBe("line one line two [31m")
    const leaky = refusalWords({ ok: false, code: "ODD", message: `got ${prefixedKey("Leakykey")} back` })!
    expect(leaky).not.toContain(prefixedKey("Leakykey"))
    expect(leaky).toContain("cndl_…")
    expect(refusalWords({ ok: false, code: "lower case", message: "" })).toBeUndefined()
    // A success, or a key with the CLI's own store failing, isn't a refusal.
    expect(refusalWords({ key: "x", keyPrefix: "Scoutkey", stored: false })).toBeUndefined()
    expect(refusalWords(undefined)).toBeUndefined()
    expect(refusalWords({ ok: false, code: "X".repeat(10), message: "y".repeat(700) })!.length).toBe(600)
  })

  test("vault status: its code, and nothing else of the output", async () => {
    expect(await captureOf({ capture: "code" }, JSON.stringify({ ok: false, code: "VAULT_MISSING", path: "/somewhere" }))).toEqual({ code: "VAULT_MISSING" })
    expect(await captureOf({ capture: "code" }, JSON.stringify({ ok: true, path: "/somewhere" }))).toBeUndefined()
  })
})

describe("the environment a pane's command gets", () => {
  const env = { HOME: "/home/someone", PATH: "/usr/bin", USER: "someone", CANDLE_HARNESS_HOME: "/x", CANDLE_API_KEY: "never", CANDLE_PROFILE: "theirs", CANDLE_CONFIG_DIR: "/cfg" }
  test("candle acts as the profile the Candle Harness records, over the person's own CANDLE_PROFILE", () => {
    const out = candleEnv(env, { identity: "owner", profile: "candle-harness" })
    expect(out.CANDLE_PROFILE).toBe("candle-harness")
    expect(out.CANDLE_API_KEY).toBeUndefined()
    expect(out.CANDLE_HARNESS_HOME).toBeUndefined()
    // With none recorded, the CLI picks as it always does.
    expect(candleEnv(env, { identity: "owner" }).CANDLE_PROFILE).toBe("theirs")
  })
  test("a harness's own sign-in runs as the person, with nothing of Candle's", () => {
    const out = candleEnv(env, { identity: "owner", harness: "codex", profile: "candle-harness" })
    expect(Object.keys(out).filter((k) => k.startsWith("CANDLE_"))).toEqual([])
    expect(out).toMatchObject({ HOME: "/home/someone", PATH: "/usr/bin" })
  })
})
