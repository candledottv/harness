// Where a holder of one Candle Hood curve stands if the launch does not migrate, and the exit itself, as Candle's
// API answers it and as `candle token exit <token>`, `candle_holder_exit`, `candle_claim_holder_exit` and the SDK's
// `getHolderExit()` and `holderExit()` read it. Recorded offline from one exact commit
// (scripts/read-holder-exit-source.ts): Candle's own pure deriveHolderExit on made-up chain facts for the read, and
// response stubs for the agent route's answers. The route, the chain read, the builder and the signer are not run.
import { describe, expect, test } from "bun:test"
import exits from "../../test/fixtures/candle-holder-exit-source.json"
import perps from "../../test/fixtures/candle-perps-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { toOutcome } from "./candle-mcp"
import { classify, TOOL_CLASSES } from "./classify"
import { rowFor, SOURCE } from "./cli-table"
import { resolveCall } from "./cli-tool"

type Row = { id: string; scenario: string; surface: string; says?: string; evidence?: string; args: Record<string, any>; requests: any[]; outcome: any }
const rows = exits.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const STATES = ["none", "awaiting-migration", "recovery-open", "recovery", "recovery-no-balance", "rescue-pending", "rescue-void", "rescued", "team-claimable", "team-stranded"] as const
type State = (typeof STATES)[number]
const OUTCOMES = ["dry-run", "complete", "partial", "indeterminate", "not-ready", "declined"] as const
type Outcome = (typeof OUTCOMES)[number]
const api = (id: State) => row(`${id}-api`).outcome as { status: number; body: { payload: { curve: string; token: string; holderExit: any } } }
const view = (id: State) => api(id).body.payload.holderExit
const cli = (id: string) => row(`${id}-cli`).outcome.lines as string[]
const stub = (id: Outcome) => row(`${id}-api`).outcome as { dry: { status: number; body: any }; real?: { status: number; body: any } }
const sentence = (lines: string[]) => lines.join(" ").replace(/\s+/g, " ")
const CURVE = "0x1111111111111111111111111111111111111111", TOKEN = "0x2222222222222222222222222222222222222222", HOLDER = "0x3333333333333333333333333333333333333333"
const READ = `/api/v1/hood/curves/${CURVE}/holder-exit`
const AGENT = `/api/v1/agent/hood/holder-exit/${CURVE}`
const DAY = 86_400

test("the recording names the exact merged source, the same commit as the CLI table, tools/list and the other source fixtures", () => {
  expect(exits.source).toEqual({ repo: "candledottv/candle-monorepo", commit: "bdf8548b9d6c3844b014f25ae1725cbae6f8b544", versions: { cli: "0.13.39", mcp: "0.10.42", sdk: "0.6.32" } })
  expect(exits.source.commit).toBe(SOURCE.source.commit)
  expect(exits.source.commit).toBe(tools.source.commit)
  expect(exits.source.commit).toBe(perps.source.commit)
  expect(rows).toHaveLength(90)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  for (const id of STATES) expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(["api-source", "cli", "cli", "mcp", "sdk"])
  for (const id of OUTCOMES) expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(id === "declined" ? ["api-stub", "cli", "mcp", "sdk"] : ["api-stub", "cli", "cli", "mcp", "sdk"])
  for (const id of STATES) expect(row(`${id}-api`).evidence).toContain("deriveHolderExit")
  for (const id of OUTCOMES) expect(row(`${id}-api`).evidence).toContain("response stub")
  expect(exits.about).toContain("No deployed behavior is claimed")
})

test("no key, and no address or hash that is not made up, is in any recording", () => {
  const text = JSON.stringify(exits)
  expect(text).not.toMatch(/cndl_|fixture-only-not-a-key/)
  const real = (text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).filter((a) => !/^0x([0-9])\1{39}$/.test(a))
  expect(real).toEqual([])
  expect(text).not.toMatch(/"(privateKey|mnemonic|seed|signature|unsignedTransaction|claimToken)"/i)
})

describe("the six states and what each surface says", () => {
  test("a launch still trading is state none with no window, no recovery and no disclosure", () => {
    expect(view("none")).toMatchObject({ generation: 2, state: "none", lifecycle: "trading", recoveryWindow: null, recovery: null, rescue: null, team: null, actions: [], disclosure: "" })
    expect(cli("none").join("\n")).toContain("State      none: ordinary trading, nothing to exit")
  })

  test("graduated and waiting: Recovery opens for the creator at day 7 and for anyone at day 30, and the holder has no action", () => {
    const w = view("awaiting-migration").recoveryWindow
    expect(view("awaiting-migration")).toMatchObject({ state: "awaiting_migration", lifecycle: "graduated", actions: [] })
    expect(w).toMatchObject({ creatorMayEnterNow: false, anyoneMayEnterNow: false })
    expect(Number(w.anyoneMayEnterAt) - Number(w.creatorMayEnterAt)).toBe(23 * DAY)
    expect(Number(w.secondsUntilPermissionlessExit)).toBe(28 * DAY)
    expect(view("awaiting-migration").disclosure).toContain(`from ${w.creatorMayEnterAt}`)
  })

  test("31 days on, anyone may open Recovery, and the holder's action is enter_recovery", () => {
    expect(view("recovery-open")).toMatchObject({ state: "recovery_open", actions: ["enter_recovery"], recoveryWindow: { anyoneMayEnterNow: true }, account: { address: HOLDER, mayEnterRecoveryNow: true, baseBalanceRaw: "10000000000000000000" } })
    expect(sentence(cli("recovery-open"))).toContain("Available now: candle token exit " + TOKEN + " --enter-recovery")
  })

  test("Recovery pays by tokens held at a fixed rate: 1000 of the quote over 2000 tokens is 0.5 each, and this wallet's 10 tokens pay 5", () => {
    expect(view("recovery")).toMatchObject({
      state: "recovery", lifecycle: "recovery", actions: ["claim_recovery"],
      recovery: { quoteDecimals: 6, reserveSnapshotRaw: "1000000000", eligibleSupplyRaw: "2000000000000000000000", remainingRaw: "2000000000000000000000", ratePerTokenRaw: "500000", paysBy: "tokens_held" },
      account: { baseBalanceRaw: "10000000000000000000", recoveryQuoteOutRaw: "5000000" },
    })
    const text = sentence(cli("recovery"))
    expect(text).toContain("Recovery rate 0.5 0x5555555555555555555555555555555555555555 per token")
    expect(text).toContain("Recovery left 2000 tokens")
    expect(text).toContain("Balance 10 tokens")
    expect(text).toContain("Recovery would pay 5 0x5555555555555555555555555555555555555555")
    expect(text).toContain(`Available now: candle token exit ${TOKEN} --recover`)
  })

  test("a wallet with no balance has nothing to claim, though Recovery is open", () => {
    expect(view("recovery-no-balance")).toMatchObject({ state: "recovery", actions: [], account: { baseBalanceRaw: "0", recoveryQuoteOutRaw: "0" } })
    expect(sentence(cli("recovery-no-balance"))).not.toContain("Available now")
  })

  test("a valid rescue request is rescue_pending and says where the quote balance goes; a void one says why and the state falls back", () => {
    expect(view("rescue-pending")).toMatchObject({ state: "rescue_pending", rescue: { to: "0x6666666666666666666666666666666666666666", valid: true, voidReason: null, executableNow: false } })
    expect(view("rescue-pending").disclosure).toContain("will move to 0x6666666666666666666666666666666666666666")
    expect(view("rescue-void")).toMatchObject({ state: "awaiting_migration", rescue: { valid: false, voidReason: "quote_readmitted", executableNow: false } })
    expect(sentence(cli("rescue-void"))).toContain("Rescue request void (quote_readmitted)")
  })

  test("a failed launch with nothing eligible left is rescued: no recovery block, no on-chain claim, no action", () => {
    expect(view("rescued")).toMatchObject({ state: "rescued", lifecycle: "recovery", recovery: null, actions: [] })
    expect(view("rescued").disclosure).toContain("There is no on-chain claim")
    expect(cli("rescued").join("\n")).toContain("State      rescued: no on-chain claim")
  })

  test("a team escrow: claimable once the launch migrated, for its recipient only; stranded when the launch failed", () => {
    expect(view("team-claimable")).toMatchObject({ state: "none", actions: ["claim_team"], team: { status: "claimable", amountRaw: "100000000000000000000", vestedRaw: "30000000000000000000", claimableRaw: "30000000000000000000" }, account: { isTeamRecipient: true } })
    expect(sentence(cli("team-claimable"))).toContain(`Available now: candle token exit ${TOKEN} --claim-team`)
    expect(view("team-stranded")).toMatchObject({ state: "recovery", team: { status: "stranded", claimableRaw: "0" }, actions: ["claim_recovery"] })
  })

  test("the disclosure is the API's sentence, printed verbatim by the CLI and relayed whole by the MCP tool and the SDK", () => {
    for (const id of STATES) {
      const { holderExit } = api(id).body.payload
      expect(row(`${id}-mcp`).outcome).toEqual({ body: api(id).body, isError: false })
      expect(row(`${id}-sdk`).outcome).toEqual({ body: api(id).body.payload, isError: false })
      expect(row(`${id}-cli-json`).outcome).toEqual({ exitCode: 0, body: api(id).body })
      if (holderExit.disclosure) expect(sentence(cli(id))).toContain(holderExit.disclosure)
      // A state with no sentence prints no note of its own: the only notes are the commands available now.
      else expect(cli(id).filter((l) => l.startsWith("  - ") && !l.startsWith("  - Available now"))).toEqual([])
    }
  })
})

describe("every read is keyless", () => {
  test("the MCP tool and the SDK are one GET of the curve's route, with ?account= when a wallet is named, and no credential", () => {
    for (const id of STATES) {
      const account = row(`${id}-mcp`).args.account as string | undefined
      const path = `${READ}${account ? `?account=${account}` : ""}`
      expect(row(`${id}-mcp`).requests).toEqual([{ method: "GET", path, credential: false }])
      expect(row(`${id}-sdk`).requests).toEqual([{ method: "GET", path }])
    }
  })

  test("the CLI reads the token's market for its curve, then the curve's route, with no key configured and none sent", () => {
    for (const id of STATES) {
      const account = row(`${id}-cli`).args.command.match(/--wallet (0x\w+)/)?.[1]
      expect(row(`${id}-cli`).requests.map((r: any) => [r.method, r.path, r.credential])).toEqual([
        ["GET", `/api/v1/markets/hood/${TOKEN}`, false],
        ["GET", `${READ}${account ? `?account=${account}` : ""}`, false],
      ])
    }
  })

  test("given a token, the MCP tool reads its market for the curve first; a token with no curve is NO_HOOD_CURVE and reads nothing more", () => {
    expect(row("by-token-mcp").requests.map((r: any) => r.path)).toEqual([`/api/v1/markets/hood/${TOKEN}`, `${READ}?account=${HOLDER}`])
    expect(row("by-token-mcp").outcome.isError).toBe(false)
    expect(row("no-curve-mcp").requests.map((r: any) => r.path)).toEqual([`/api/v1/markets/hood/${TOKEN}`])
    expect(row("no-curve-mcp").outcome).toMatchObject({ isError: true, body: { success: false, error: { code: "NO_HOOD_CURVE" } } })
    expect(row("no-curve-cli-json").outcome).toMatchObject({ exitCode: 1, body: { ok: false, code: "NO_HOOD_CURVE" } })
  })
})

describe("the exit", () => {
  test("a dry run signs nothing: outcome not_started, the calls not sent, and what the claim would pay; the MCP tool's dryRun defaults to true", () => {
    expect(stub("dry-run").dry.body).toMatchObject({ success: true, dryRun: true, signable: true, outcome: "not_started", build: { amountRaw: "10000000000000000000", expectedQuoteOutRaw: "5000000" } })
    expect(stub("dry-run").dry.body.calls.map((c: any) => [c.kind, c.status, c.txHash])).toEqual([["approve", "not_sent", null], ["claim_recovery", "not_sent", null]])
    expect(row("dry-run-mcp").args).toEqual({ curve: CURVE, action: "claim_recovery" })
    expect(row("dry-run-mcp").requests[0].body).toEqual({ action: "claim_recovery", dryRun: true })
    // The SDK sends false unless asked, and the CLI's dry run is the same request.
    expect(row("dry-run-sdk").requests[0].body).toEqual({ action: "claim_recovery", dryRun: true })
    expect(row("complete-sdk").requests[0].body).toEqual({ action: "claim_recovery", dryRun: false })
    expect(row("complete-mcp").requests[0].body).toEqual({ action: "claim_recovery", dryRun: false })
    expect(row("dry-run-cli").outcome.exitCode).toBe(0)
    expect(sentence(row("dry-run-cli").outcome.lines)).toContain("Dry run Action Redeem at the Recovery rate")
    expect(sentence(row("dry-run-cli").outcome.lines)).toContain("Nothing was sent.")
  })

  test("an agent key goes only to the agent route, and an exit sends only action, amountRaw, dryRun and wallet", () => {
    for (const id of OUTCOMES) {
      expect(row(`${id}-mcp`).requests.map((r: any) => [r.method, r.path, r.credential])).toEqual([["POST", AGENT, true]])
      expect(row(`${id}-sdk`).requests.map((r: any) => [r.method, r.path])).toEqual([["POST", AGENT]])
      for (const r of [...row(`${id}-mcp`).requests, ...row(`${id}-sdk`).requests]) expect(Object.keys(r.body).sort()).toEqual(["action", "dryRun"])
    }
  })

  test("the CLI runs the API's dry run first and the real run only after it, and never sends one it was not given a yes for", () => {
    const posts = (id: string) => row(id).requests.filter((r: any) => r.method === "POST").map((r: any) => r.body.dryRun)
    expect(posts("complete-cli")).toEqual([true, false])
    expect(posts("complete-cli-json")).toEqual([true, false])
    expect(posts("dry-run-cli")).toEqual([true])
    expect(posts("declined-cli")).toEqual([true])
    expect(row("declined-cli").args).toMatchObject({ command: `candle token exit ${TOKEN} --recover`, answer: "n" })
    expect(row("declined-cli").outcome).toMatchObject({ exitCode: 5, prompts: ["Redeem at the Recovery rate now? [y/N] "] })
    expect(sentence(row("declined-cli").outcome.lines)).toContain("Cancelled. Nothing was sent.")
  })

  test("a completed exit: both calls confirmed, the claim booked, outcome complete", () => {
    const real = stub("complete").real!
    expect(real).toMatchObject({ status: 200, body: { success: true, dryRun: false, outcome: "complete" } })
    expect(real.body.calls.map((c: any) => [c.kind, c.status, c.recorded])).toEqual([["approve", "confirmed", "not_recorded"], ["claim_recovery", "confirmed", "booked"]])
    expect(row("complete-mcp").outcome).toEqual({ body: real.body, isError: false })
    expect(row("complete-sdk").outcome).toEqual({ body: real.body, isError: false })
    expect(row("complete-cli-json").outcome).toEqual({ exitCode: 0, body: real.body })
    expect(sentence(row("complete-cli").outcome.lines)).toContain("Outcome complete")
  })

  test("a partial exit is a refusal that carries outcome, calls and warnings, and the CLI says an approval landed and the claim did not", () => {
    const body = stub("partial").real!.body
    expect(stub("partial").real!.status).toBe(409)
    expect(row("partial-sdk").outcome).toEqual({
      isError: true,
      body: { code: "HOOD_EXIT_FAILED", status: 409, message: "The exit did not complete", retryable: true, stage: "reverted", outcome: "partial", calls: body.calls, warnings: body.warnings },
    })
    expect(body.calls.map((c: any) => [c.kind, c.status])).toEqual([["approve", "confirmed"], ["claim_recovery", "reverted"]])
    expect(row("partial-mcp").outcome).toEqual({ body, isError: true })
    expect(row("partial-cli-json").outcome).toMatchObject({ exitCode: 1, body: { ok: false, code: "HOOD_EXIT_FAILED", details: { outcome: "partial", warnings: body.warnings } } })
    expect(row("partial-cli").outcome.exitCode).toBe(1)
    expect(row("partial-cli").outcome.stderr).toContain("HOOD_EXIT_FAILED: The exit did not complete")
  })

  test("an indeterminate exit is exit 3 in the CLI: a call was sent and its result is not known, so read before running it again", () => {
    const body = stub("indeterminate").real!.body
    expect(body).toMatchObject({ outcome: "indeterminate", error: { stage: "unconfirmed" } })
    expect(body.calls.map((c: any) => [c.kind, c.status])).toEqual([["approve", "confirmed"], ["claim_recovery", "submitted_unknown"]])
    expect(row("indeterminate-cli").outcome.exitCode).toBe(3)
    expect(row("indeterminate-cli-json").outcome).toMatchObject({ exitCode: 3, body: { code: "HOOD_EXIT_FAILED", details: { outcome: "indeterminate" } } })
    expect(row("indeterminate-sdk").outcome.body).toMatchObject({ outcome: "indeterminate", status: 502, retryable: true })
  })

  test("a refusal keeps the API's code and its details; the CLI prints the code and the disclosure beside it", () => {
    const refusal = stub("not-ready").dry
    expect(refusal.status).toBe(409)
    expect(refusal.body.error).toMatchObject({ code: "HOOD_RECOVERY_NOT_READY", retryable: false, stage: "not_broadcast", details: { creatorMayEnterAt: expect.stringMatching(/^\d+$/), anyoneMayEnterAt: expect.stringMatching(/^\d+$/) } })
    expect(row("not-ready-sdk").outcome).toMatchObject({ isError: true, body: { code: "HOOD_RECOVERY_NOT_READY", status: 409, details: refusal.body.error.details } })
    expect(row("not-ready-mcp").outcome).toEqual({ body: refusal.body, isError: true })
    expect(row("not-ready-cli").outcome.exitCode).toBe(1)
    const err = sentence(row("not-ready-cli").outcome.stderr)
    expect(err).toContain("HOOD_RECOVERY_NOT_READY: Recovery isn't open for this wallet yet.")
    expect(err).toContain("This launch graduated and is waiting for its pool.")
    expect(row("not-ready-cli-json").outcome).toMatchObject({ exitCode: 1, body: { ok: false, code: "HOOD_RECOVERY_NOT_READY", details: { refusal: refusal.body.error.details } } })
  })

  test("an exit has no keyless form: the MCP tool and the SDK refuse before any request", () => {
    expect(row("no-key-mcp")).toMatchObject({ requests: [], outcome: { isError: true } })
    expect(row("no-key-mcp").outcome.body.text).toContain("CANDLE_AGENT_API_KEY is required")
    expect(row("no-key-sdk")).toMatchObject({ requests: [], outcome: { isError: true } })
    expect(row("no-key-sdk").outcome.message).toContain("holderExit() requires an apiKey")
  })
})

describe("portfolio, and Candle's pages", () => {
  test("`candle portfolio` marks a Hood position in recovery, rescue_pending or rescued, from one market read per token (source text, not a run)", () => {
    const { outcome } = row("portfolio-marks-source")
    expect(outcome.states).toContain('["recovery", "rescue_pending", "rescued"]')
    expect(outcome.words).toEqual(['recovery: "in Recovery",', 'rescue_pending: "rescue pending, buying closed",', 'rescued: "rescued, no on-chain claim",'])
    expect(outcome.limits).toEqual(["const EXIT_MARKS_MAX_TOKENS = 50", "const EXIT_MARKS_IN_FLIGHT = 8"])
    expect(outcome.jsonKeys).toEqual(["holderExits", "holderExitsUnread", "holderExit"])
    expect(row("portfolio-marks-source").surface).toBe("source-text")
  })

  test("Candle's CLI and MCP pages and the SDK changelog describe the same surface", () => {
    expect(row("docs-cli").outcome.text).toContain("--recover")
    expect(row("docs-cli").outcome.text).toContain("--enter-recovery")
    expect(row("docs-cli").outcome.text).toContain("--claim-team")
    expect(row("docs-mcp-read").outcome.text).toStartWith("| `candle_holder_exit` | `GET /api/v1/hood/curves/")
    expect(row("docs-mcp-claim").outcome.text).toStartWith("| `candle_claim_holder_exit` | `POST /api/v1/agent/hood/holder-exit/")
    expect(row("docs-sdk-changelog").outcome.text).toMatch(/^Release 0\.6\.28 \(BE-3794\), with CLI 0\.13\.34 and MCP 0\.10\.39\./)
  })
})

describe("in the Candle Harness", () => {
  test("both tools are in the source tools/list: the read takes curve, token and account, the exit takes curve, action, amountRaw, dryRun and wallet", () => {
    const read = tools.tools.find((t) => t.name === "candle_holder_exit")
    const claim = tools.tools.find((t) => t.name === "candle_claim_holder_exit")
    expect(Object.keys(read!.inputSchema.properties)).toEqual(["curve", "token", "account"])
    expect(Object.keys(claim!.inputSchema.properties)).toEqual(["curve", "action", "amountRaw", "dryRun", "wallet"])
    expect(claim!.inputSchema.required).toEqual(["curve", "action"])
    expect(tools.tools.find((t) => t.name === "candle_get_market")!.description).toContain("holderExit.disclosure")
  })

  test("the read is a read; the exit moves funds, has no card here yet, and is refused by name, never offered", () => {
    expect(TOOL_CLASSES.candle_holder_exit).toEqual({ class: "read" })
    for (const mode of ["live", "paper"] as const) expect(classify("candle_holder_exit", { curve: CURVE }, mode)).toEqual({ class: "read" })
    for (const mode of ["live", "paper"] as const)
      expect(classify("candle_claim_holder_exit", { curve: CURVE, action: "claim_recovery", dryRun: false }, mode)).toMatchObject({ class: "refused", code: "NOT_YET_SUPPORTED", listed: false })
    expect(TOOL_CLASSES.candle_claim_holder_exit).toMatchObject({ class: "refused", reason: expect.stringContaining("candle_holder_exit") })
  })

  test("the agent reads the read tool's answer whole, disclosure included", () => {
    for (const id of STATES) {
      const { outcome } = row(`${id}-mcp`)
      expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(outcome.body) }], isError: outcome.isError })).toEqual({ kind: "ok", result: api(id).body })
    }
  })

  test("`candle token exit <token>` through candle_cli is a read, with --dry-run too; an exit itself is funds out and later, and --yes is never the agent's", () => {
    expect(SOURCE.commands.find((c) => c.command === "token" && c.subcommand === "exit")).toMatchObject({
      identity: "agent", json: true, flags: { value: ["--amount", "--wallet"], boolean: ["--claim-team", "--dry-run", "--enter-recovery", "--recover", "--yes"] },
    })
    expect(rowFor("token exit")).toMatchObject({ rule: "read", route: "cli", identity: "agent" })
    const defaults = { defaultAgent: "momentum", agents: new Set(["momentum"]) }
    const routed = (args: string[]) => resolveCall({ command: "token", subcommand: "exit", args }, defaults)
    for (const args of [[TOKEN], [TOKEN, "--wallet", HOLDER], [TOKEN, "--recover", "--dry-run"], [TOKEN, "--enter-recovery", "--dry-run"]]) {
      const r = routed(args)
      expect(r.ok && [r.call.rule, r.call.route]).toEqual(["read", "cli"])
    }
    for (const flag of ["--recover", "--enter-recovery", "--claim-team"]) {
      const r = routed([TOKEN, flag])
      expect(r.ok && [r.call.rule, r.call.route]).toEqual(["funds-out", "later"])
    }
    expect(routed([TOKEN, "--recover", "--yes"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
  })
})
