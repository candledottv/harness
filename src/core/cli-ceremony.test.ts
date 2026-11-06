// Ceremony rows through the prompt pane: the steps where the user types or is shown a
// secret at the CLI's own prompt. Each row's argv and card words; the paths the user names in the
// pane, and nowhere else; the canary for `vault phrase show`; the outcome words, which never say
// nothing was shown; and the kill switch, which withdraws `wallets import` only.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import { PANE_SOCKET_ENV, PANE_TICKET_ENV } from "../pane/launcher"
import type { Card } from "./cards"
import { pausedStops } from "./classify"
import { CLI_ROWS, sourceFor, unlocksFor } from "./cli-table"
import { describeTool, resolveCall } from "./cli-tool"
import { paneRowNow } from "./owner-rows"
import { type PaneResult, paneOutcome, paneSteps, planPane } from "./pane-plan"

const MAIN = join(import.meta.dir, "../main.ts")
const PASS = "correct horse battery staple"
const PHRASE = Array.from({ length: 24 }, (_, i) => `ceremonyword${i}`).join(" ")

const dirs: string[] = []
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  cleanupHomes()
})

const finalArgs = (args: string[], o: { json: boolean; rpcUrl: boolean }) => [...args, ...(o.json ? ["--json"] : [])]
/** The words after `candle`, split as a typed line is: the second word is a subcommand only if the CLI has it. */
const resolveWords = (words: string[]) => {
  const [command, maybe, ...rest] = words
  const sub = maybe !== undefined && sourceFor(command!, maybe) !== undefined
  return resolveCall({ command, ...(sub ? { subcommand: maybe } : {}), args: sub ? rest : words.slice(1) }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
}
const resolve = (words: string[]) => {
  const r = resolveWords(words)
  if (!r.ok) throw new Error(`${words.join(" ")}: ${r.message}`)
  return r.call
}
const plan = (words: string[]) => {
  const call = resolve(words)
  return { call, params: planPane({ row: call.row, rule: call.rule, identity: call.identity, ...(call.agent ? { agent: call.agent } : {}), words: call.argv, rpcUrl: false, finalArgs }) }
}

// The ceremony table, with the owner rows' ceremonies (`auth login`, `setup`, `update`, `vault init`)
// and the two the table also holds: `verify` (a file the user names) and `vault status --unlock`.
const CEREMONIES = ["auth login", "setup", "update", "verify", "vault init", "vault phrase", "vault restore", "vault factor", "vault factor add", "vault enroll", "vault export-key", "wallets import", "sign", "sign message", "secrets set", "quant terms"]

describe("the table", () => {
  test("every ceremony runs in the pane now, and none takes the factor step: each asks for what it needs itself", () => {
    const ceremonies = CLI_ROWS.filter((r) => r.rule === "ceremony" && r.route === "pane")
    expect(ceremonies.map((r) => r.path).sort()).toEqual([...CEREMONIES].sort())
    for (const row of ceremonies) {
      expect(`${row.path}: ${paneRowNow(row.rule, row.route)}`).toBe(`${row.path}: true`)
      expect(`${row.path}: ${row.pane!.factorFirst}`).toBe(`${row.path}: false`)
    }
    // vault status --unlock is a ceremony by its flag: the factor step itself, run on its own.
    expect(resolve(["vault", "status", "--unlock"])).toMatchObject({ rule: "ceremony", route: "pane" })
    // The ones that never unlock are the ones the plan's "asks for what it needs" is about: the key, the secret, the browser.
    expect(ceremonies.filter((r) => unlocksFor(r.path) === "never").map((r) => r.path).sort()).toEqual(["auth login", "quant terms", "secrets set", "setup", "update", "vault restore", "verify", "wallets import"])
  })

  test("each row's argv and identity: the words as given, no --json (nothing is piped), the agent's key only for wallets import", () => {
    const rows: [string[], string, "agent" | "owner"][] = [
      [["wallets", "import", "--chain", "solana", "--label", "cold"], "wallets import", "agent"],
      [["vault", "phrase", "show"], "vault phrase", "owner"],
      [["vault", "restore", "--phrase"], "vault restore", "owner"],
      [["vault", "factor", "add", "passphrase"], "vault factor add", "owner"],
      [["vault", "enroll", "security-key"], "vault enroll", "owner"],
      [["vault", "export-key", "main"], "vault export-key", "owner"],
      [["sign", "--wallet", "ext-1"], "sign", "owner"],
      [["sign", "message", "--wallet", "ext-1"], "sign message", "owner"],
      [["secrets", "set", "openai"], "secrets set", "owner"],
    ]
    for (const [words, row, identity] of rows) {
      const { params } = plan(words)
      expect(params.pane).toMatchObject({ row, rule: "ceremony", identity, factorFirst: false })
      expect(params.pane.steps).toEqual([{ stage: "command", argv: words }])
      expect(params.pane.capture).toBeUndefined()
      if (identity === "agent") expect(params.pane.agent).toBe("momentum")
      else expect(params.pane.agent).toBeUndefined()
    }
  })

  test("the paths the agent can't give are named in the pane: --to, --file, and verify's file and bundle", () => {
    expect(plan(["vault", "export-key", "main"]).params.pane.askPaths).toEqual([{ flag: "--to", prompt: "A new file to write the key to" }])
    expect(plan(["sign", "--wallet", "ext-1"]).params.pane.askPaths).toEqual([{ flag: "--file", prompt: "The transaction file to sign" }])
    expect(plan(["sign", "message", "--wallet", "ext-1"]).params.pane.askPaths).toEqual([{ flag: "--file", prompt: "The message file to sign" }])
    const verify = plan(["verify"])
    expect(verify.params.pane.askPaths).toEqual([
      { flag: "<file>", prompt: "The file to check" },
      { flag: "--bundle", prompt: "Its signature bundle" },
    ])
    expect(paneSteps(verify.call.row, verify.params)).toEqual(["you'll name the file in the pane", "you'll name --bundle in the pane"])
    for (const words of [
      ["vault", "export-key", "main", "--to", "/tmp/k.json"],
      ["sign", "--file", "/tmp/tx.bin"],
      ["wallets", "import", "--chain", "solana", "--key-file", "/tmp/k"],
      ["vault", "enroll", "security-key", "--install-helper"],
      ["vault", "init", "--keystore", "/tmp/v"],
    ]) {
      expect(resolveWords(words)).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    }
  })

  test("a secret never goes on a command line: secrets set takes the name only, wallets import no positional", () => {
    for (const words of [
      ["secrets", "set", "openai", "sk-not-a-real-secret"],
      ["wallets", "import", "--chain", "solana", "5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3"],
    ]) {
      const r = resolveWords(words)
      expect(r).toMatchObject({ ok: false, code: "SECRET_AT_THE_PROMPT" })
      expect((r as { message: string }).message).toContain("hidden prompt")
      expect((r as { message: string }).message).not.toContain(words.at(-1)!)
    }
  })
})

describe("the card's words: what each shows or takes", () => {
  test("each ceremony says it, in the plan's words", () => {
    const shows = (words: string[]) => plan(words).call.row.pane!.shows
    expect(shows(["wallets", "import", "--chain", "solana"])).toBe("You'll paste a private key into the CLI's hidden prompt.")
    expect(shows(["vault", "init"])).toBe("Makes a vault on this machine. It may show your new passphrase and your 24 words.")
    expect(shows(["vault", "phrase", "show"])).toBe("Shows your 24 words.")
    expect(shows(["vault", "restore", "--phrase"])).toBe("You'll type your 24 words. It may show a new passphrase.")
    expect(shows(["vault", "factor", "add", "passphrase"])).toBe("Adds a factor. It may show a new passphrase.")
    expect(shows(["vault", "enroll", "security-key"])).toBe("Adds a factor. It may show a new passphrase.")
    expect(shows(["vault", "export-key", "main"])).toBe("Writes the key, unencrypted, to a new file you name in the pane.")
    expect(shows(["secrets", "set", "openai"])).toBe("You'll type the secret into the CLI's hidden prompt. It never goes to Candle.")
  })

  test("the card names the key it signs with, and says when it also sends", async () => {
    const s = await setup()
    const one = s.t.core.cards.get((await s.call({ command: "sign", args: ["--wallet", "ext-1"] })).cardId)!
    expect(one.display.paneShows).toBe("Signs with ext-1.")
    const sends = s.t.core.cards.get((await s.call({ command: "sign", args: ["--wallet", "ext-2", "--broadcast"] })).cardId)!
    expect(sends.display.paneShows).toBe("Signs with ext-2, then sends it to the chain.")
    // A multi-signer transaction names each signer, not only the first.
    const both = s.t.core.cards.get((await s.call({ command: "sign", args: ["--wallet", "ext-1", "--wallet", "ext-2"] })).cardId)!
    expect(both.display.paneShows).toBe("Signs with ext-1 and ext-2.")
    const msg = s.t.core.cards.get((await s.call({ command: "sign", subcommand: "message", args: [] })).cardId)!
    expect(msg.display.paneShows).toBe("Signs with an external key, the one the CLI picks: no --wallet is named.")
  }, 30_000)

  test("the agent is told ceremonies are the user's, and which are on the pane now", () => {
    const text = describeTool()
    const line = text.split("\n").find((l) => l.startsWith("At the CLI's own prompt"))!
    for (const path of ["vault phrase", "secrets set", "wallets import", "vault export-key", "sign message"]) expect(line).toContain(path)
    expect(text.split("\n").find((l) => l.startsWith("Coming: ")) ?? "").not.toContain("vault phrase")
  })
})

describe("the outcome words", () => {
  const phrase = resolve(["vault", "phrase", "show"]).row.pane!
  const opts = { fundsOut: false, reveals: phrase.reveals }

  test("vault phrase show, exit 1: didn't finish, and it may have shown the words; never that nothing was shown", () => {
    const r = paneOutcome({ stage: "command", exit: 1 }, opts)
    expect(r).toMatchObject({ outcome: "didnt_finish", words: "didn't finish: it may have shown your 24 words before it stopped." })
    const stopped = paneOutcome({ stage: "command", stopped: true }, opts)
    expect(stopped).toMatchObject({ outcome: "stopped", words: "stopped in the pane before it finished. It may have shown your 24 words." })
    for (const w of [r.words, stopped.words]) {
      expect(w.toLowerCase()).not.toContain("nothing was shown")
      expect(w).not.toContain("Nothing was run")
    }
    // Before the command ran, nothing could have been shown, and the words say so as for any pane.
    expect(paneOutcome({ stage: "paths", stopped: true }, opts).words).toBe("stopped in the pane before the command ran. Nothing was run.")
  })

  test("a row that shows nothing keeps the usual words; vault restore's exit 3 says what to check", () => {
    expect(paneOutcome({ stage: "command", exit: 1 }, { fundsOut: false }).words).toBe("didn't finish: refused, or answered no at the CLI's prompt.")
    const restore = resolve(["vault", "restore", "--phrase"]).row.pane!
    const r = paneOutcome({ stage: "command", exit: 3 }, { fundsOut: false, reveals: restore.reveals, exit3: restore.exit3 })
    expect(r).toMatchObject({ outcome: "pending", words: "restored, but not confirmed (exit 3): the CLI couldn't read every linked wallet. Check with candle vault status before anything else." })
  })

  test("tee disable's exit 3 is a stop not yet confirmed, not something that may still land", () => {
    const spec = resolve(["tee", "disable", "TeeFake111111111111111111111111111111111111"]).row.pane!
    const r = paneOutcome({ stage: "command", exit: 3 }, { fundsOut: false, ...(spec.exit3 ? { exit3: spec.exit3 } : {}) })
    expect(r.words).toBe("the stop is asked for, but Candle hasn't confirmed it's enforced yet (exit 3). Check with candle tee status before trading from this wallet.")
  })
})

describe("the kill switch", () => {
  test("paused, it withdraws wallets import and a sign that sends, since it sends what it signed; the other ceremonies spend nothing and widen nothing", () => {
    const card = (row: string, words?: string[]) => ({ kind: "ceremony" as const, tool: "candle_cli", row, ...(words ? { words } : {}) })
    expect(pausedStops(card("wallets import"))).toBe(true)
    expect(pausedStops(card("sign", ["sign", "--wallet", "ext-1", "--broadcast"]))).toBe(true)
    expect(pausedStops(card("sign message", ["sign", "message", "--broadcast"]))).toBe(true)
    expect(pausedStops(card("sign", ["sign", "--wallet", "ext-1"]))).toBe(false)
    // A card that's already made goes by the argv its pane will run.
    const made = { ...card("sign"), params: { pane: { steps: [{ stage: "command", argv: ["sign", "--wallet", "ext-1", "--broadcast", "--rpc-url", "https://rpc.example"] }] } } }
    expect(pausedStops(made)).toBe(true)
    for (const row of CEREMONIES.filter((r) => r !== "wallets import")) expect(`${row}: ${pausedStops(card(row))}`).toBe(`${row}: false`)
  })

  test("through a running core: the import card is withdrawn and a new one refused, typed or proposed; vault phrase show stays", async () => {
    const s = await setup()
    const imp = s.t.core.cards.get((await s.call({ command: "wallets", subcommand: "import", args: ["--chain", "solana"] })).cardId)!
    const phrase = s.t.core.cards.get((await s.call({ command: "vault", subcommand: "phrase", args: ["show"] })).cardId)!
    expect(imp).toMatchObject({ kind: "ceremony", route: "pane", row: "wallets import" })
    await s.view.request("kill", {})
    expect(s.t.core.cards.get(imp.cardId)!.state).toBe("withdrawn")
    expect(s.t.core.cards.get(phrase.cardId)!.state).toBe("awaiting_approval")
    expect((await s.call({ command: "wallets", subcommand: "import", args: ["--chain", "solana", "--label", "x"] })).error.code).toBe("PAUSED")
    expect((await s.view.request("cli.run", { argv: ["wallets", "import", "--chain", "solana"] })).error?.data?.code).toBe("PAUSED")
    expect(((await s.view.request("cli.run", { argv: ["secrets", "set", "openai"] })).result as { ticket?: string }).ticket).toStartWith("chp_")
  }, 30_000)

  test("through a running core: a sign that sends is withdrawn and refused, typed or proposed; a plain sign stays", async () => {
    const s = await setup()
    const sends = s.t.core.cards.get((await s.call({ command: "sign", args: ["--wallet", "ext-1", "--broadcast"] })).cardId)!
    const plain = s.t.core.cards.get((await s.call({ command: "sign", args: ["--wallet", "ext-1"] })).cardId)!
    await s.view.request("kill", {})
    expect(s.t.core.cards.get(sends.cardId)!.state).toBe("withdrawn")
    expect(s.t.core.cards.get(plain.cardId)!.state).toBe("awaiting_approval")
    const again = await s.call({ command: "sign", subcommand: "message", args: ["--broadcast"] })
    expect(again.error.code).toBe("PAUSED")
    expect(again.error.message).toContain("sending a signed transaction")
    expect((await s.view.request("cli.run", { argv: ["sign", "--wallet", "ext-2", "--broadcast"] })).error?.data?.code).toBe("PAUSED")
    expect(((await s.view.request("cli.run", { argv: ["sign", "--wallet", "ext-2"] })).result as { ticket?: string }).ticket).toStartWith("chp_")
  }, 30_000)
})

// ---- Through a running core, and the launcher in a real PTY as the view starts it. ----

function cliDir(script: Record<string, unknown>): string {
  const dir = mkdtempSync("/tmp/chrn-cer-")
  dirs.push(dir)
  writeFileSync(join(dir, "fake-cli.json"), JSON.stringify(script))
  return dir
}
const runs = (dir: string): { argv: string[] }[] => {
  try {
    return readFileSync(join(dir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function setup(script: Record<string, unknown> = {}) {
  const dir = cliDir({ vault: { passphrase: PASS }, ...script })
  const t = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: dir } })
  cores.push(t)
  const view = await t.view()
  const { client: harness } = await t.harness(view)
  const call = async (args: Record<string, unknown>) => JSON.parse(((await harness.request("tools.call", { name: "candle_cli", args })).result as { content: { text: string }[] }).content[0]!.text)
  return { t, view, harness, call, dir }
}

interface Pane {
  proc: Bun.Subprocess
  screen(): string
  type(text: string): void
}

async function openPane(t: TestCore, view: TestClient, opened: { ticket: string; ticketId: string }, dir: string): Promise<Pane> {
  let out = ""
  const decoder = new TextDecoder()
  const proc = Bun.spawn([process.execPath, MAIN, "cli-pane"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", TERM: "xterm-256color", CANDLE_CONFIG_DIR: dir, [PANE_TICKET_ENV]: opened.ticket, [PANE_SOCKET_ENV]: t.p.socket },
    terminal: { cols: 100, rows: 30, data: (_t, chunk) => void (out += decoder.decode(chunk, { stream: true })) },
  })
  expect((await view.request("pane.spawned", { ticketId: opened.ticketId, pid: proc.pid })).result).toEqual({ ok: true })
  return { proc, screen: () => out, type: (text) => void proc.terminal!.write(text) }
}

async function typed(view: TestClient, argv: string[]): Promise<{ ticket: string; ticketId: string; card: Card }> {
  const answer = await view.request("cli.run", { argv })
  if (answer.error) throw new Error(JSON.stringify(answer.error))
  return answer.result as { ticket: string; ticketId: string; card: Card }
}
const told = (t: TestCore, opId: string) => (t.core.operations.get(opId)!.result as { pane: PaneResult }).pane

describe("in the pane", () => {
  test("the canary: vault phrase show's words are on the pane and nowhere else; a failed read-back is \"didn't finish\"", async () => {
    const s = await setup({ phrase: PHRASE })
    await s.view.request("subscribe", { topics: ["status", "cards", "operations", "activity", "agent"] })
    await s.harness.request("subscribe", { topics: ["cards", "operations"] })
    // From the agent: a card, which runs nothing until the pane.
    const asked = await s.call({ command: "vault", subcommand: "phrase", args: ["show"], reason: "you asked to check your backup" })
    const card = s.t.core.cards.get(asked.cardId)!
    expect(card).toMatchObject({ kind: "ceremony", route: "pane" })
    expect(card.display.paneShows).toBe("Shows your 24 words.")
    expect(card.display.headline).toBe("AT THE PROMPT · candle vault phrase show")
    expect(runs(s.dir).filter((r) => r.argv[0] === "vault" && r.argv[1] === "phrase")).toEqual([])
    const approved = (await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "click" })).result as { ticket: string; ticketId: string }
    const pane = await openPane(s.t, s.view, approved, s.dir)
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await until(() => pane.screen().includes("Type understood"))
    pane.type("understood\r")
    await until(() => pane.screen().includes("Type words 3, 11 and 20"))
    pane.type("wrong words here\r")
    await pane.proc.exited
    // It was on the pane...
    expect(pane.screen()).toContain(PHRASE)
    // ...and nowhere else, nor the passphrase.
    const journal = readFileSync(s.t.p.journal, "utf8")
    for (const secret of [PHRASE, "ceremonyword7", PASS]) {
      expect(journal).not.toContain(secret)
      for (const frame of [...s.view.frames, ...s.harness.frames]) expect(frame).not.toContain(secret)
    }
    expect(told(s.t, card.opId)).toMatchObject({ outcome: "didnt_finish", words: "didn't finish: it may have shown your 24 words before it stopped." })
    expect(pane.screen()).toContain("it may have shown your 24 words")
  }, 30_000)

  test("vault export-key: the path is asked in the pane, goes on candle's command line, and is in no card, frame or journal row", async () => {
    const s = await setup()
    await s.view.request("subscribe", { topics: ["cards", "operations", "activity"] })
    const path = join(s.dir, "exported-from-the-pane.json")
    const r = await typed(s.view, ["vault", "export-key", "main"])
    expect(s.t.core.cards.get(r.card.cardId)!.approvedHow).toBe("typed")
    const pane = await openPane(s.t, s.view, r, s.dir)
    await until(() => pane.screen().includes("A new file to write the key to"))
    pane.type(`${path}\r`)
    await pane.proc.exited
    expect(runs(s.dir).at(-1)!.argv).toEqual(["vault", "export-key", "main", "--to", path])
    expect(told(s.t, r.card.opId).outcome).toBe("finished")
    expect(readFileSync(s.t.p.journal, "utf8")).not.toContain("exported-from-the-pane")
    expect(JSON.stringify(s.t.core.cards.get(r.card.cardId))).not.toContain("exported-from-the-pane")
    for (const frame of s.view.frames) expect(frame).not.toContain("exported-from-the-pane")
  }, 30_000)

  test("verify: its file goes on as a positional, then --bundle; never the word <file>", async () => {
    const s = await setup()
    const r = await typed(s.view, ["verify"])
    const pane = await openPane(s.t, s.view, r, s.dir)
    await until(() => pane.screen().includes("The file to check"))
    pane.type("/tmp/candle.tar.gz\r")
    await until(() => pane.screen().includes("Its signature bundle"))
    pane.type("/tmp/candle.sigstore\r")
    await pane.proc.exited
    expect(runs(s.dir).at(-1)!.argv).toEqual(["verify", "/tmp/candle.tar.gz", "--bundle", "/tmp/candle.sigstore"])
  }, 30_000)

  test("secrets set: the secret is typed at the CLI's hidden prompt, and reaches nothing but candle", async () => {
    const s = await setup()
    const secret = "sk-ceremony-not-a-real-secret"
    const r = await typed(s.view, ["secrets", "set", "openai"])
    const pane = await openPane(s.t, s.view, r, s.dir)
    await until(() => pane.screen().includes("Secret value (input hidden)"))
    pane.type(`${secret}\r`)
    await pane.proc.exited
    expect(told(s.t, r.card.opId).outcome).toBe("finished")
    expect(pane.screen()).not.toContain(secret)
    expect(readFileSync(s.t.p.journal, "utf8")).not.toContain(secret)
    for (const frame of s.view.frames) expect(frame).not.toContain(secret)
    expect(readFileSync(join(s.dir, "fake-cli-secrets.json"), "utf8")).toContain(secret)
  }, 30_000)
})
