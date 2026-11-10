// candle_cli: the agent's route to every CLI command, run by the core under each row's rule. Pins
// that candle_cli can't be talked out of its table.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_KEY, cleanupHomes, fakeCandle, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { describeTool, resolveCall } from "./cli-tool"

const ctx = { defaultAgent: "momentum", agents: new Set(["momentum", "swing"]) }
const resolve = (command: string, subcommand: string | undefined, args: string[] = [], agent?: string) =>
  resolveCall({ command, ...(subcommand ? { subcommand } : {}), args, ...(agent ? { agent } : {}) }, ctx)

describe("refusals", () => {
  test("a command or subcommand the table doesn't have", () => {
    expect(resolve("rm", undefined)).toMatchObject({ ok: false, code: "NOT_IN_MAP" })
    expect(resolve("keys", "obliterate")).toMatchObject({ ok: false, code: "NOT_IN_MAP" })
    expect(resolve("keys", undefined)).toMatchObject({ ok: false, code: "NOT_IN_MAP" })
    expect(resolve("toString", undefined)).toMatchObject({ ok: false, code: "NOT_IN_MAP" })
  })

  test("a word given as the subcommand of a command that has none says to put it in args (help keys)", () => {
    expect(resolve("help", "keys")).toEqual({ ok: false, code: "NOT_IN_MAP", message: 'candle help has no subcommands: pass "keys" in args instead (candle help keys).' })
    expect(resolve("help", undefined, ["keys"])).toMatchObject({ ok: true })
    expect(resolve("rm", "rf")).toMatchObject({ ok: false, code: "NOT_IN_MAP", message: "candle rm isn't a command in candle 0.13.18, the CLI the Candle Harness was checked against." })
  })

  test("flags that change who or where it runs, --yes and --rpc-url are refused, even where the command declares them", () => {
    for (const [cmd, sub, flag] of [
      ["keys", "update", "--yes"],
      ["tee", "status", "--rpc-url"],
      ["tee", "status", "--keystore"],
      ["keys", "list", "--profile"],
      ["keys", "list", "--api-url"],
      ["keys", "list", "--json"],
      ["keys", "list", "--factor"],
      ["vault", "status", "--accept-older-copy"],
      ["portfolio", undefined, "--evm-rpc-url"],
    ] as const) {
      const r = resolve(cmd, sub, [flag, "x"])
      expect(`${cmd} ${sub ?? ""} ${flag}: ${r.ok ? "ok" : r.code}`).toBe(`${cmd} ${sub ?? ""} ${flag}: FLAG_NOT_ALLOWED`)
    }
  })

  test("path flags and positional paths are refused", () => {
    expect(resolve("wallets", "import", ["--key-file", "/tmp/k"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect(resolve("vault", "backup", ["--to", "/tmp/b"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect(resolve("verify", undefined, ["/tmp/candle"])).toMatchObject({ ok: false, code: "PATH_NOT_ALLOWED" })
    // image upload's path is the one the agent may give: its card holds it to the research folder.
    expect(resolve("image", "upload", ["/etc/passwd"])).toMatchObject({ ok: true })
  })

  test("--flag=value, a short -k, and arguments that are really a second command", () => {
    expect(resolve("keys", "list", ["--profile=other"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect(resolve("tee", "status", ["-k", "/tmp/v"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    for (const bad of [";", "&&", "|", "||", "&", "a\nrm -rf /", "a\0b"]) {
      expect(resolve("keys", "revoke", [bad])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    }
    expect(resolve("keys", "revoke", Array.from({ length: 65 }, () => "a"))).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve("keys", "revoke", ["x".repeat(5000)])).toMatchObject({ ok: false, code: "BAD_ARGS" })
  })

  test("a flag given twice is refused, so the rule and the checks read the value the CLI runs with", () => {
    for (const [cmd, sub, args] of [
      ["keys", "access", ["abc", "--access", "withdraw", "--access", "read"]],
      ["keys", "access", ["abc", "--access", "read", "--access", "withdraw"]],
      ["keys", "update", ["abc", "--embedded-wallet", "allow", "--embedded-wallet", "deny"]],
      ["keys", "wallets", ["scope", "abc", "--scope", "all", "--scope", "selected"]],
      ["keys", "create", ["--label", "x", "--access", "read", "--access", "withdraw"]],
      ["vault", "transfer", ["cold", "--amount", "0.1", "--asset", "SOL", "--from", "t", "--amount", "100"]],
      ["keys", "access", ["abc", "--history", "--history"]],
    ] as const) {
      const r = resolve(cmd, sub, [...args])
      expect(`${cmd} ${sub} ${args.join(" ")}: ${r.ok ? "ok" : r.code}`).toBe(`${cmd} ${sub} ${args.join(" ")}: BAD_ARGS`)
    }
    // The flags the CLI itself reads more than once still repeat.
    expect(resolve("wallets", "close-empty", ["--wallet", "tee-one", "--keep", "MintA", "--keep", "MintB"])).toMatchObject({ ok: true })
  })

  test("a row picked by its words takes no extra word, so an extra one can't run as something else", () => {
    expect(resolve("plan", "auto-renew", ["off", "on"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve("plan", "auto-renew", ["off"])).toMatchObject({ ok: true, call: { rule: "less-access" } })
    expect(resolve("keys", "access", ["abc", "def", "--access", "read"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve("keys", "update", ["abc", "def", "--embedded-wallet", "deny"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve("keys", "self", ["embedded-wallet", "deny", "allow"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve("keys", "wallets", ["scope", "abc", "def", "--scope", "selected"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve("keys", "self", ["embedded-wallet", "deny"])).toMatchObject({ ok: true, call: { rule: "less-access" } })
  })

  test("an action word that isn't first is refused, never read as the row without it", () => {
    expect(resolve("keys", "wallets", ["--wallets", "X", "set"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve("keys", "wallets", ["--scope", "selected", "scope", "abc"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve("keys", "wallets", [])).toMatchObject({ ok: true, call: { rule: "read" } })
  })

  test("an unknown agent is refused, never run as the active one", () => {
    expect(resolve("wallets", undefined, [], "ghost")).toMatchObject({ ok: false, code: "UNKNOWN_AGENT" })
  })
})

describe("rules", () => {
  test("keys access: --history reads, --access read narrows, anything else is the owner's", () => {
    expect(resolve("keys", "access", ["abc", "--history"])).toMatchObject({ ok: true, call: { rule: "read", route: "cli" } })
    expect(resolve("keys", "access", ["abc", "--access", "read"])).toMatchObject({ ok: true, call: { rule: "less-access", route: "cli", argv: ["keys", "access", "abc", "--access", "read", "--yes"] } })
    expect(resolve("keys", "access", ["abc", "--access", "withdraw"])).toMatchObject({ ok: true, call: { rule: "owner", route: "pane" } })
    expect(resolve("keys", "access", ["abc", "--access", "write"])).toMatchObject({ ok: true, call: { rule: "owner", route: "pane" } })
  })

  test("keys wallets scope: selected narrows; all is refused from a key, so it's Candle's agent console (0.12.0)", () => {
    expect(resolve("keys", "wallets", ["scope", "abc", "--scope", "selected"])).toMatchObject({ ok: true, call: { rule: "less-access", identity: "agent", agent: "momentum" } })
    expect(resolve("keys", "wallets", ["scope", "abc", "--scope", "all"])).toMatchObject({ ok: true, call: { rule: "never" } })
  })

  test("--rpc-url is added from config only where the command takes it", () => {
    expect(resolve("tee", "status", ["Wallet1"])).toMatchObject({ ok: true, call: { withRpcUrl: true } })
    expect(resolve("keys", "list")).toMatchObject({ ok: true, call: { withRpcUrl: false } })
  })

  test("the description names the commands, their rules and what holds them", () => {
    const d = describeTool()
    expect(d).toContain("keys revoke")
    expect(d).toContain("portfolio → candle_get_portfolio")
    // Every pane row runs now, so nothing is said to be coming; held rows say why.
    expect(d).not.toContain("Coming: ")
    expect(d).toContain("Not in the Candle Harness: transfer.")
    expect(d).toContain("--profile")
    // The two that ask at the CLI's own prompt aren't said to run at once.
    const reads = d.split("\n").find((l) => l.startsWith("Runs at once"))!
    expect(reads).not.toContain("tee fund")
    expect(d.split("\n").find((l) => l.startsWith("Asks for the user's vault passphrase"))).toContain("tee fund, tee disable")
    // Without these lines, the agent asked for a backup's path in chat, hedged on --tx-limit's reset, and took a TEE launch as ready.
    expect(d).toContain("Never ask the user for a path a step takes")
    expect(d).toContain("reset daily unless --reset says otherwise")
    expect(d).toContain("A TEE wallet allowed to launch still can't launch through the Candle Harness")
  })

  test("a path the pane asks for is refused from the agent with what to do instead", () => {
    const r = resolve("vault", "backup", ["--to", "/somewhere/backup"])
    expect(r).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect((r as { message: string }).message).toContain("the prompt pane asks the user for it")
  })
})

// Through a whole core, with the fake `candle` recording every run.
const cores: TestCore[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
afterAll(cleanupHomes)

async function setup(home: Parameters<typeof startTestCore>[1] = {}) {
  const runsDir = mkdtempSync("/tmp/chrn-runs-")
  dirs.push(runsDir)
  const c = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: runsDir } }, home)
  cores.push(c)
  const view = await c.view()
  const { client: harness } = await c.harness(view)
  const runs = () =>
    existsSync(join(runsDir, "fake-cli-runs.jsonl"))
      ? readFileSync(join(runsDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> })
      : []
  const call = async (args: Record<string, unknown>) => {
    const answer = await harness.request("tools.call", { name: "candle_cli", args })
    return JSON.parse((answer.result as { content: { text: string }[] }).content[0]!.text)
  }
  return { c, view, harness, runs, call, dir: runsDir }
}

describe("candle_cli through the core", () => {
  test("it's offered to the agent", async () => {
    const s = await setup()
    const tools = ((await s.harness.request("tools.list")).result as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name)).toContain("candle_cli")
  })

  test("a read runs at once with the agent's key, and its output comes back redacted and labelled candle", async () => {
    const s = await setup()
    const out = await s.call({ command: "wallets" })
    expect(out).toMatchObject({ source: "candle", command: "candle wallets --json", exitCode: 0 })
    expect(JSON.stringify(out)).not.toContain(AGENT_KEY)
    expect(out.output.apiKey).toBe("[redacted]")
    const [run] = s.runs()
    expect(run!.argv).toEqual(["wallets", "--json"])
    expect(run!.env.CANDLE_API_KEY).toBe(AGENT_KEY)
  })

  test("an owner-identity read runs as the user's own profile: no key at all", async () => {
    const s = await setup()
    await s.call({ command: "keys", subcommand: "list" })
    expect(s.runs()[0]!.env.CANDLE_API_KEY).toBeUndefined()
  })

  test("the agent's keys revoke becomes a card, and runs only when the user approves it", async () => {
    const s = await setup()
    const answer = await s.call({ command: "keys", subcommand: "revoke", args: ["abc123"], reason: "the user asked to cut off the old bot" })
    expect(answer.error.code).toBe("APPROVAL_REQUIRED")
    expect(s.runs()).toEqual([])
    const card = s.c.core.cards.get(answer.cardId)!
    expect(card.display.title).toBe("LESS ACCESS · candle keys revoke abc123")
    expect(card.params).toMatchObject({ argv: ["keys", "revoke", "abc123", "--json"], identity: "owner" })
    expect(card.display.why).toBe("the user asked to cut off the old bot")
    const approved = await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    expect(approved.result).toMatchObject({ kind: "submitted", operation: { state: "succeeded" } })
    expect(s.runs().map((r) => r.argv)).toEqual([["keys", "revoke", "abc123", "--json"]])
    expect(s.runs()[0]!.env.CANDLE_API_KEY).toBeUndefined() // keys revoke is the owner's (device token)
  })

  test("the user's typed candle keys revoke runs at once, as the user's", async () => {
    const s = await setup()
    const result = await s.view.request("cli.run", { argv: ["keys", "revoke", "abc123"] })
    expect(result.result).toMatchObject({ source: "candle", exitCode: 0 })
    expect(s.runs().map((r) => r.argv)).toEqual([["keys", "revoke", "abc123", "--json"]])
    expect(s.c.core.journal.rows().some((r) => r.type === "cli.typed")).toBe(true)
    // And what came of it, not only the request.
    expect(s.c.core.journal.rows().find((r) => r.type === "cli.typed_result")).toMatchObject({ argv: ["keys", "revoke", "abc123"], exitCode: 0, timedOut: false })
  })

  test("widening access is an owner card that runs nothing, never Withdraw on an agent's key; a harness can't call cli.run", async () => {
    const s = await setup({ keys: { momentum: prefixedKey("Momentum") } })
    const out = await s.call({ command: "keys", subcommand: "access", args: ["abc", "--access", "write"] })
    expect(out.error.code).toBe("APPROVAL_REQUIRED")
    expect(s.c.core.cards.get(out.cardId)).toMatchObject({ kind: "owner", route: "pane", row: "keys access" })
    const agentKey = await s.call({ command: "keys", subcommand: "access", args: ["Momentum", "--access", "withdraw"] })
    expect(agentKey.error.code).toBe("NO_WITHDRAW_KEY")
    expect((await s.harness.request("cli.run", { argv: ["keys", "list"] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    // Only the reads the card needed: the CLI's version, the key's scopes, and whether there's a vault for the factor.
    expect(s.runs().map((r) => r.argv.slice(0, 2))).toEqual([["--version"], ["keys", "list"], ["vault", "status"]])
  })

  test("a harness runs candle_cli only as its own agent: another agent's name is refused, and nothing runs with its key", async () => {
    const momentum = prefixedKey("Momentum")
    const swing = prefixedKey("Swingkey")
    const s = await setup({ keys: { momentum, swing } })
    const tools = ((await s.harness.request("tools.list")).result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools
    expect(Object.keys(tools.find((t) => t.name === "candle_cli")!.inputSchema.properties)).not.toContain("agent")
    for (const args of [{ command: "wallets", agent: "swing" }, { command: "image", subcommand: "upload", args: ["memory/index.md"], agent: "swing" }]) {
      expect((await s.call(args)).error.code).toBe("NOT_YOUR_AGENT")
    }
    expect(s.runs()).toEqual([])
    expect(s.c.core.cards.list()).toEqual([])
    // Its own name, or none, runs with its own key.
    expect((await s.call({ command: "wallets", agent: "momentum" })).exitCode).toBe(0)
    expect((await s.call({ command: "wallets" })).exitCode).toBe(0)
    expect(s.runs().map((r) => r.env.CANDLE_API_KEY)).toEqual([momentum, momentum])
  })

  test("what Candle's MCP tools do, and what's never the agent's, are pointed elsewhere", async () => {
    const s = await setup()
    expect((await s.call({ command: "portfolio" })).error).toMatchObject({ code: "USE_MCP_TOOL" })
    expect((await s.call({ command: "tui" })).error).toMatchObject({ code: "NOT_FOR_AGENT" })
    const transfer = (await s.call({ command: "transfer", args: ["--amount", "1"] })).error
    expect(transfer.code).toBe("NOT_YET")
    // Held, since funds go out only by the owner's vault-signed routes, and the agent is told why and what to use.
    expect(transfer.message).toContain("Withdraw key")
    expect(transfer.message).toContain("vault transfer")
    expect(s.runs()).toEqual([])
  })

  test("tee disable and tee fund ask at the CLI's own prompt, so the core never runs them: the agent's is a pane card; typed, tee fund opens the pane and a stop, which is final, is a card", async () => {
    const s = await setup()
    for (const args of [{ command: "tee", subcommand: "disable", args: ["Wallet1"] }, { command: "tee", subcommand: "fund", args: ["Wallet1", "--amount", "0.1"] }]) {
      const out = await s.call(args)
      expect(out.error.code).toBe("APPROVAL_REQUIRED")
      const card = s.c.core.cards.get(out.cardId)!
      expect(card.route).toBe("pane")
      expect(card.display.paneSteps!.join(" ")).toContain("passphrase")
    }
    const fund = await s.view.request("cli.run", { argv: ["tee", "fund", "Wallet1", "--amount", "0.1"] })
    expect(fund.result).toMatchObject({ kind: "pane", ticket: expect.stringMatching(/^chp_/), card: { approvedHow: "typed" } })
    // A stop is for good (the CLI never re-enables a TEE wallet), so even typed it's a card with the amber line, read before the press.
    const typed = await s.view.request("cli.run", { argv: ["tee", "disable", "Wallet1"] })
    expect(typed.result).toMatchObject({ kind: "card", said: expect.stringContaining("a stop is for good") })
    const stop = s.c.core.cards.get((typed.result as { cardId: string }).cardId)!
    expect(stop.state).toBe("awaiting_approval")
    expect(stop.display.warning).toContain("Candle never re-enables a stopped TEE wallet")
    // Nothing ran but the CLI's version, read once for the first card.
    expect(s.runs().map((r) => r.argv)).toEqual([["--version"]])
    // A tee status without --verify is still a read, run at once.
    expect((await s.call({ command: "tee", subcommand: "status", args: ["Wallet1"] })).exitCode).toBe(0)
  })

  test("on a CLI older than the Candle Harness needs, a pane step is refused with what to run, and candle update still opens", async () => {
    const s = await setup()
    writeFileSync(join(s.dir, "fake-cli.json"), JSON.stringify({ version: "0.13.5" }))
    const out = await s.call({ command: "tee", subcommand: "fund", args: ["Wallet1", "--amount", "0.1"] })
    expect(out.error.code).toBe("CLI_TOO_OLD")
    expect(out.error.message).toBe("candle 0.13.5 is older than the Candle Harness needs (0.13.18): run candle update, then ask again. Nothing was run.")
    expect((await s.view.request("cli.run", { argv: ["update"] })).result).toMatchObject({ kind: "pane" })
    // Updated, the next step goes, with no restart.
    writeFileSync(join(s.dir, "fake-cli.json"), JSON.stringify({ version: "0.13.18" }))
    expect((await s.call({ command: "tee", subcommand: "fund", args: ["Wallet1", "--amount", "0.1"] })).error.code).toBe("APPROVAL_REQUIRED")
  })

  test("the RPC from config never reaches the agent, nor a command line other users can read", async () => {
    const RPC = "https://rpc.example.test/secret-path-token/"
    const s = await setup({ config: { candle: { mcp: { route: "cli", path: "candle-mcp" }, cliPath: await fakeCandle(), rpcUrl: RPC, profile: undefined } } })
    const answer = await s.harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "status", args: ["Wallet1"] } })
    const text = (answer.result as { content: { text: string }[] }).content[0]!.text
    expect(JSON.parse(text).exitCode).toBe(0)
    expect(text).not.toContain("secret-path-token")
    expect(JSON.parse(text).command).toBe("candle tee status Wallet1 --json")
    const [run] = s.runs()
    expect(run!.argv).not.toContain("--rpc-url")
    expect(run!.env.CANDLE_SOLANA_RPC_URL).toBe(RPC)
  })

  test("candle swap points at candle_trade or candle_swap with wallet; typed, at buy, sell or swap … from", async () => {
    const s = await setup()
    const out = await s.call({ command: "swap", args: ["SOL", "USDC", "--amount", "0.1"] })
    expect(out.error.code).toBe("USE_MCP_TOOL")
    expect(out.error.message).toContain("candle_trade or candle_swap with wallet")
    const typed = await s.view.request("cli.run", { argv: ["swap", "SOL", "USDC", "--amount", "0.1"] })
    expect(typed.error?.data).toMatchObject({ code: "USE_THE_HARNESS" })
    expect(typed.error?.message).toContain("from <wallet>")
    expect(s.runs()).toEqual([])
    // swap status is still a read.
    await s.call({ command: "swap", subcommand: "status", args: ["abc"] })
    expect(s.runs().map((r) => r.argv)).toEqual([["swap", "status", "abc", "--json"]])
  })

  test("staking, launches, fee claims, profile edits and posts point at Candle's own tools; typed, at the agent", async () => {
    const s = await setup()
    const cases: [string, string | undefined, string[], string][] = [
      ["fees", "claim", ["MoonFake11111111111111111111111111111111111"], "candle_claim_fees"],
      ["agent", "post", ["create"], "candle_create_post"],
      ["stake", "add", ["10"], "candle_stake"],
      ["launch", undefined, ["--name", "Fake", "--symbol", "FAKE"], "candle_launch_token"],
    ]
    for (const [command, subcommand, args, tool] of cases) {
      const out = await s.call({ command, ...(subcommand ? { subcommand } : {}), args })
      expect(`${command}: ${out.error.code}`).toBe(`${command}: USE_MCP_TOOL`)
      expect(out.error.message).toContain(tool)
    }
    const typed = await s.view.request("cli.run", { argv: ["fees", "claim", "MoonFake11111111111111111111111111111111111"] })
    expect(typed.error?.data).toMatchObject({ code: "ASK_THE_AGENT" })
    expect(typed.error?.message).toContain("candle_claim_fees")
    expect(s.runs()).toEqual([])
  })

  test("0.13.5: launch --check reads, by the agent and typed; wallet is the CLI's alias for wallets", async () => {
    const s = await setup()
    const out = await s.call({ command: "launch", args: ["--check"] })
    expect(out).toMatchObject({ source: "candle", command: "candle launch --check --json", exitCode: 0 })
    expect(s.runs()[0]!.env.CANDLE_API_KEY).toBe(AGENT_KEY)
    const typed = await s.view.request("cli.run", { argv: ["launch", "--check"] })
    expect(typed.error).toBeUndefined()
    expect(s.runs().map((r) => r.argv)).toEqual([
      ["launch", "--check", "--json"],
      ["launch", "--check", "--json"],
    ])
    // Without --check it's still Candle's own tool.
    expect((await s.call({ command: "launch", args: ["--name", "Fake"] })).error.code).toBe("USE_MCP_TOOL")
    // The CLI resolves `wallet` before routing; so does the core, and it runs the canonical word.
    await s.call({ command: "wallet" })
    expect(s.runs().at(-1)!.argv).toEqual(["wallets", "--json"])
    expect(resolve("wallet", "close-empty")).toMatchObject({ ok: true })
  })

  test("0.13.9: the strategy lab goes to hacc_lab and agent positions to Candle's tool, by the agent and typed; nothing runs", async () => {
    const s = await setup()
    const lab = await s.call({ command: "lab", subcommand: "status" })
    expect(lab.error.code).toBe("USE_MCP_TOOL")
    expect(lab.error.message).toStartWith("Use hacc_lab")
    expect(lab.error.message).not.toContain("Candle's own tool")
    const typed = await s.view.request("cli.run", { argv: ["lab", "replay"] })
    expect(typed.error?.data?.code).toBe("ASK_THE_AGENT")
    expect(typed.error?.message).toContain("hacc_lab")
    const positions = await s.call({ command: "agent", subcommand: "positions", args: ["some-agent"] })
    expect(positions.error.code).toBe("USE_MCP_TOOL")
    expect(positions.error.message).toContain("candle_get_agent_positions")
    expect(s.runs()).toEqual([])
  })

  test("the card's hash covers the argv: a changed argument is a different card, and a tampered one never runs", async () => {
    const s = await setup()
    const a = await s.call({ command: "keys", subcommand: "revoke", args: ["abc123"] })
    const b = await s.call({ command: "keys", subcommand: "revoke", args: ["abc124"] })
    const cardA = s.c.core.cards.get(a.cardId)!
    expect(cardA.cardHash).not.toBe(s.c.core.cards.get(b.cardId)!.cardHash)
    ;(cardA.params as { argv: string[] }).argv = ["keys", "revoke", "someone-else"]
    expect((await s.view.request("cards.approve", { cardId: cardA.cardId, cardHash: cardA.cardHash })).error?.data?.code).toBe("CARD_CHANGED")
    await until(() => true)
    expect(s.runs()).toEqual([])
  })
})

describe("the stranding warning", () => {
  const TEE = { id: "teeid1", address: "TeeFake111111111111111111111111111111111111", label: "bot-wallet", boundKeyPrefix: "Momentum" }
  const home = { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: { teeWallets: [TEE] }, swing: { teeWallets: [TEE] } } }
  const STRANDED = "This key holds TEE wallet bot-wallet. Revoking leaves it stranded until the owner rebinds it (candle tee rebind)."
  const profileReads = (s: Awaited<ReturnType<typeof setup>>) =>
    readFileSync(join(s.c.p.stateDir, "candle", "momentum", "fake-candle-calls.jsonl"), "utf8").split("\n").filter((l) => l.includes("candle_get_profile_wallets")).length

  test("revoking a key that holds a TEE wallet says so on the card, before the press; still one press", async () => {
    const s = await setup(home)
    const answer = await s.call({ command: "keys", subcommand: "revoke", args: ["Momentum"] })
    const card = s.c.core.cards.get(answer.cardId)!
    expect(card.display.warning).toBe(STRANDED)
    // A key holding none gets no line.
    const other = await s.call({ command: "keys", subcommand: "revoke", args: ["Swingkey"] })
    expect(s.c.core.cards.get(other.cardId)!.display.warning).toBeUndefined()
    // Approving it reads every agent's wallets again.
    const before = profileReads(s)
    expect((await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result).toMatchObject({ kind: "submitted" })
    await until(() => profileReads(s) > before)
  })

  test("a wallet set that leaves out a TEE wallet the key holds says so; one that keeps it doesn't", async () => {
    const s = await setup(home)
    const drop = await s.call({ command: "keys", subcommand: "wallets", args: ["set", "Momentum", "--wallets", "wal_other"] })
    expect(s.c.core.cards.get(drop.cardId)!.display.warning).toBe("This key holds TEE wallet bot-wallet. Leaving it out of the set strands it until the owner rebinds it (candle tee rebind).")
    const keep = await s.call({ command: "keys", subcommand: "wallets", args: ["set", "Momentum", "--wallets", "wal_other,teeid1"] })
    expect(s.c.core.cards.get(keep.cardId)!.display.warning).toBeUndefined()
  })

  test("a typed revoke still runs at once, and says the same afterwards", async () => {
    const s = await setup(home)
    const result = await s.view.request("cli.run", { argv: ["keys", "revoke", "Momentum"] })
    expect(result.result).toMatchObject({ exitCode: 0, warning: STRANDED })
    expect(s.runs().map((r) => r.argv)).toEqual([["keys", "revoke", "Momentum", "--json"]])
  })
})
