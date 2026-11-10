// Code bots, by their parts: bots.toml reads and writes a code bot beside rules bots; its hash binds every run
// setting its card approves; a change is said and sorted wider or narrower; its token is a bot's alone, kept across
// restarts, replaced by each issue and refused once revoked; and the redactor takes a bot's or a Build pane's token.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { BotsFileStore, type CodeBotEntry, parseBotsFile, serializeBotsFile } from "./bots-file"
import { codeBotCard, codeBotHash, codeBotWords, codeChanges, type CodeRunSettings, commandShown, folderShown } from "./code-bots"
import { TokenBook } from "./tokens"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "code-bots-"))
  dirs.push(d)
  return d
}

const RUN: CodeRunSettings = { agent: "agent-a", wallet: "embedded", mode: "paper", folder: "/srv/bots/momentum", command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 10, maxOpen: 3 }
const ENTRY: CodeBotEntry = { kind: "code", name: "momentum", state: "on", ...RUN }
const CODE_TOML = `[bots.momentum]\nkind = "code"\nagent = "agent-a"\nwallet = "embedded"\nmode = "paper"\nstate = "on"\nfolder = "/srv/bots/momentum"\ncommand = ["bun", "run", "bot.ts"]\nperTradeUsd = 2\nperDayUsd = 10\nmaxOpen = 3\n`
const RULES_TOML = `[bots.conf]\nagent = "agent-a"\nwallet = "embedded"\nmode = "paper"\nstate = "on"\n\n[bots.conf.definition]\nchain = "solana"\n\n[bots.conf.definition.entry]\nsource = "pattern"\npattern = "confluence"\n\n[bots.conf.definition.exit]\nstop_loss_pct = 40\n\n[bots.conf.definition.sizing]\nusd_per_trade = 2\nmax_concurrent = 4\n`

describe("bots.toml with a code bot", () => {
  test("a code bot reads beside a rules bot, and writes back exactly", () => {
    const read = parseBotsFile(`${CODE_TOML}\n${RULES_TOML}`)
    expect(read.problems).toEqual([])
    expect(read.code).toEqual([ENTRY])
    expect(read.bots.map((b) => b.name)).toEqual(["conf"])
    const back = parseBotsFile(serializeBotsFile([...read.bots, ...read.code]))
    expect(back).toEqual(read)
  })

  test("each thing a code bot can't hold is named with its line, and that bot is left out", () => {
    const said = (extra: string, swap?: [string, string]) => {
      const text = swap ? CODE_TOML.replace(swap[0], swap[1]) : CODE_TOML
      const r = parseBotsFile(`${text}${extra}`)
      return { code: r.code.length, problems: r.problems.join(" | ") }
    }
    expect(said("", ['folder = "/srv/bots/momentum"', 'folder = "bots/momentum"'])).toEqual({ code: 0, problems: expect.stringContaining("folder is an absolute path") })
    expect(said("", ['folder = "/srv/bots/momentum"', 'folder = "/srv/bots/../etc"'])).toEqual({ code: 0, problems: expect.stringContaining("no . or ..") })
    expect(said("", ['command = ["bun", "run", "bot.ts"]', 'command = "bun run bot.ts"'])).toEqual({ code: 0, problems: expect.stringContaining("command is a list of words") })
    expect(said("", ['command = ["bun", "run", "bot.ts"]', "command = []"])).toEqual({ code: 0, problems: expect.stringContaining("command is a list of words") })
    expect(said("", ["perDayUsd = 10", "perDayUsd = 1"])).toEqual({ code: 0, problems: expect.stringContaining("perDayUsd is at least perTradeUsd") })
    expect(said("", ["perTradeUsd = 2", "perTradeUsd = 0"])).toEqual({ code: 0, problems: expect.stringContaining("perTradeUsd is the most one buy may spend") })
    expect(said("", ["maxOpen = 3", "maxOpen = 2.5"])).toEqual({ code: 0, problems: expect.stringContaining("maxOpen is how many positions") })
    expect(said("", ['kind = "code"', 'kind = "python"'])).toEqual({ code: 0, problems: expect.stringContaining('kind is "code"') })
    // A rules bot's definition on a code bot, and a code bot's folder on a rules bot, are each named.
    expect(said('\n[bots.momentum.definition]\nchain = "solana"\n').problems).toContain(`"definition" is a rules bot's, not a code bot's`)
    expect(parseBotsFile(RULES_TOML.replace('state = "on"', 'state = "on"\nfolder = "/srv/x"')).problems.join()).toContain(`"folder" is a code bot's (kind = "code"), not a rules bot's`)
  })

  test("the store never writes a rules bot over a code bot of that name, or the other way, and writes 0600", () => {
    const path = join(scratch(), "bots.toml")
    const store = new BotsFileStore(path)
    expect(store.write({ momentum: ENTRY })).toEqual({ ok: true })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const rules = parseBotsFile(RULES_TOML).bots[0]!
    expect(store.write({ momentum: { ...rules, name: "momentum" } })).toEqual({ ok: false, message: 'A code bot is already named "momentum", so nothing changed.' })
    expect(store.write({ conf: rules })).toEqual({ ok: true })
    expect(store.write({ conf: { ...ENTRY, name: "conf" } })).toEqual({ ok: false, message: 'A rules bot is already named "conf", so nothing changed.' })
    expect(store.read().code).toEqual([ENTRY])
    expect(store.read().bots.map((b) => b.name)).toEqual(["conf"])
  })
})

describe("what a code bot's card binds", () => {
  test("its hash binds every run setting, and not its name", () => {
    const base = codeBotHash(RUN)
    const changed: [keyof CodeRunSettings, unknown][] = [
      ["agent", "agent-b"],
      ["wallet", "So11111111111111111111111111111111111111112"],
      ["mode", "live"],
      ["folder", "/srv/bots/other"],
      ["command", ["bun", "run", "other.ts"]],
      ["perTradeUsd", 3],
      ["perDayUsd", 11],
      ["maxOpen", 4],
      ["maxSlippageBps", 300],
    ]
    for (const [key, value] of changed) expect([key, codeBotHash({ ...RUN, [key]: value } as CodeRunSettings) === base]).toEqual([key, false])
    expect(codeBotHash({ ...RUN })).toBe(base)
  })

  test("lower figures and a bound tightened to the route's default are narrower; a raised figure, a bound under the default, live, another wallet, folder or command are wider", () => {
    expect(codeChanges(RUN, { ...RUN, perTradeUsd: 1, perDayUsd: 5, maxOpen: 2 }, 100)).toEqual({ what: ["a trade's figure $1.00, from $2.00", "a day's figure $5.00, from $10.00", "open at most 2, from 3"], wider: [] })
    expect(codeChanges({ ...RUN, maxSlippageBps: 300 }, { ...RUN, maxSlippageBps: 100 }, 100)).toEqual({ what: ["a slippage bound of 1%, from 3%"], wider: [] })
    // Under the route's own bound, its sells and held exits may not fill: that's the person's press.
    expect(codeChanges(RUN, { ...RUN, maxSlippageBps: 50 }, 100)).toEqual({ what: ["a slippage bound of 0.5%, from 1%"], wider: ["a slippage bound of 0.5% is under the route's 1%, and a bound that tight can make its sells fail"] })
    expect(codeChanges({ ...RUN, maxSlippageBps: 150 }, { ...RUN, maxSlippageBps: 20 }, 100).wider).toHaveLength(1)
    expect(codeChanges(RUN, { ...RUN, perTradeUsd: 3 }, 100).wider).toEqual(["a trade's figure $3.00, from $2.00"])
    expect(codeChanges(RUN, { ...RUN, maxSlippageBps: 500 }, 100).wider).toEqual(["a slippage bound of 5%, from 1%"])
    expect(codeChanges(RUN, { ...RUN, mode: "live" }, 100).wider).toEqual(["live, from paper"])
    expect(codeChanges({ ...RUN, mode: "live" }, RUN, 100).wider).toEqual(["paper, from live"])
    expect(codeChanges(RUN, { ...RUN, wallet: "So11111111111111111111111111111111111111112" }, 100).wider).toEqual(["another wallet pays"])
    expect(codeChanges(RUN, { ...RUN, wallet: "WalletTee1" }, 100, (w) => (w === "embedded" ? "the embedded wallet" : "agent-a-tee")).wider).toEqual(["pays from agent-a-tee, from the embedded wallet"])
    expect(codeChanges(RUN, { ...RUN, folder: "/srv/bots/other" }, 100).wider).toEqual(["the folder /srv/bots/other, from /srv/bots/momentum"])
    expect(codeChanges(RUN, { ...RUN, command: ["node", "bot.js"] }, 100).wider).toEqual(["the command node bot.js, from bun run bot.ts"])
    expect(codeChanges(RUN, RUN, 100)).toEqual({ what: [], wider: [] })
  })

  test("its words: the command as a line, the folder from home, its figures", () => {
    expect(folderShown("/srv/home/you/candle-bots/m", "/srv/home/you")).toBe("~/candle-bots/m")
    expect(folderShown("/srv/other", "/srv/home/you")).toBe("/srv/other")
    expect(commandShown(["python3", "my bot.py", "--fast"])).toBe('python3 "my bot.py" --fast')
    expect(codeBotWords(RUN)).toBe("Runs bun run bot.ts in /srv/bots/momentum, held to $2.00 a trade, $10.00 a day and 3 open at once.")
  })

  test("the card: its figures, its command, what the core holds it to; a live bot on a shared wallet leads with a wallet of its own", () => {
    const check = { name: "momentum", run: { ...RUN, mode: "live" as const }, hash: "h", words: "", paysFrom: "embedded" }
    const card = codeBotCard(check, { pays: undefined, sharedWith: ["you and every agent"], ownWallet: [{ label: "new TEE wallet for agent-a", line: "candle vault promote" }] })
    expect(card.title).toBe('NEW CODE BOT "momentum"')
    expect(card.params).toEqual({ action: "saveCode", name: "momentum", proposal: { name: "momentum", run: { ...RUN, mode: "live" } }, proposer: "agent-a", hash: "h", replace: false })
    expect(card.spec.code).toEqual({ folder: "/srv/bots/momentum", command: "bun run bot.ts", figures: "$2.00 a trade · $10.00 a day · 3 open at most", holds: "The core holds this bot to these figures. What it trades inside them is its code's." })
    expect(card.spec.parts?.sells).toContain("on their own, on any wallet")
    expect(card.warning).toContain("A wallet of its own is the better way")
    expect(card.fills).toHaveLength(1)
    expect(JSON.parse(card.spec.definition)).toEqual({ ...RUN, mode: "live" })
    // On paper, no steer.
    const paper = codeBotCard({ ...check, run: RUN }, { pays: undefined, sharedWith: ["you and every agent"], ownWallet: [] })
    expect(paper.warning).toBeUndefined()
    expect(paper.spec.runs.kind).toBe("paper")
  })
})

describe("a code bot's token", () => {
  const open = async (dir: string, at = 1_000) => TokenBook.open({ tokens: join(dir, "tokens.json"), viewToken: join(dir, "view.token") }, () => at)

  test("is a bot's alone, kept across restarts, replaced by each issue, refused once revoked; harness and build tokens don't outlive the core", async () => {
    const dir = scratch()
    const book = await open(dir)
    const first = await book.mintBot("momentum", "agent-a")
    expect(first.token).toMatch(/^chb_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/)
    expect(book.authenticate(first.token)).toEqual({ role: "bot", tokenId: first.tokenId, bot: "momentum", agent: "agent-a" })
    // A bot's token with its last character changed, or as another kind, is nobody's.
    expect(book.authenticate(`${first.token.slice(0, -1)}${first.token.endsWith("A") ? "B" : "A"}`)).toBeUndefined()
    expect(book.authenticate(first.token.replace(/^chb_/, "cht_"))).toBeUndefined()
    const harness = await book.mintHarness("Claude Code", "agent-a")
    const build = await book.mintBuild("Build pane", "agent-a")
    expect(build.token).toMatch(/^chd_/)
    expect(book.authenticate(build.token)).toEqual({ role: "build", tokenId: build.tokenId, name: "Build pane", agent: "agent-a" })

    // Only hashes on disk, 0600.
    const disk = readFileSync(join(dir, "tokens.json"), "utf8")
    expect(statSync(join(dir, "tokens.json")).mode & 0o777).toBe(0o600)
    // The secret is everything after `ch?_<id>_`; it may itself hold an underscore.
    for (const t of [first.token, harness.token, build.token]) expect(disk).not.toContain(t.slice("chb_".length + 12 + 1))

    // A restart: the bot's token holds; the turn's and the pane's don't.
    const again = await open(dir)
    expect(again.authenticate(first.token)).toMatchObject({ role: "bot", bot: "momentum" })
    expect(again.authenticate(harness.token)).toBeUndefined()
    expect(again.authenticate(build.token)).toBeUndefined()

    // Issued again: the old one is refused.
    const second = await again.mintBot("momentum", "agent-a")
    expect(again.authenticate(first.token)).toBeUndefined()
    expect(again.authenticate(second.token)).toMatchObject({ role: "bot" })
    expect(again.botToken("momentum")).toEqual({ tokenId: second.tokenId, createdAt: second.createdAt })
    expect(await again.revokeBot("momentum")).toBe(second.tokenId)
    expect(again.authenticate(second.token)).toBeUndefined()
    expect(await again.revokeBot("momentum")).toBeUndefined()
  })

  test("the redactor takes a bot's and a Build pane's token, held or not", async () => {
    const book = await open(scratch())
    const bot = await book.mintBot("momentum", "agent-a")
    const build = await book.mintBuild("Build pane", "agent-a")
    const r = new Redactor()
    expect(r.text(`token ${bot.token} and ${build.token}`)).toBe("token [redacted] and [redacted]")
    // Its id alone, as the journal names it, stays.
    expect(r.text(`token ${bot.tokenId}`)).toBe(`token ${bot.tokenId}`)
  })
})
