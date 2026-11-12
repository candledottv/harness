// Perps writes that only lower the account's risk: close, cancel, tpsl, schedule-cancel and flatten as one-press
// cards from the EVM TEE wallet, held until perps.writes is on; reduce-only on as a narrowing; the kill switch,
// the outcome rules and the scope a key may never hold.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../config"
import { SETTINGS } from "../config-settings"
import { paths } from "../paths"
import type { PayerResult } from "./agent-wallets"
import { classify, pausedStops } from "./classify"
import { type CliCardRequest, type CliPlanContext, cloidOf, mapCliRow, planCliRow, UploadStage } from "./cli-cards"
import { FORBIDDEN_FLAGS, PERPS_HELD, rowFor } from "./cli-table"
import { describeTool, heldNow, resolveCall } from "./cli-tool"
import { prepareKeysCreate } from "./owner-rows"

const EVM_TEE = "0x00000000000000000000000000000000000e7ee1"
const OP_ID = "0f8fad5b-d9cb-469f-a165-70867728950e"
const CLOID = "0xabcdefabcdefabcdefabcdefabcdef12"

class Refused extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const tee: PayerResult = { ok: true, kind: "tee", address: EVM_TEE, id: "tee_1", label: "hl-one", chain: "hood" }
const embedded: PayerResult = { ok: true, kind: "embedded", address: "0x00000000000000000000000000000000000e3b01", chain: "hood" }

const PERPS_READ = {
  orders: { orders: [{ coin: "BTC", side: "buy", size: "0.1", price: "60000" }, { coin: "ETH", side: "sell", size: "2", price: "4000" }] },
  positions: { rows: [{ coin: "SOL", side: "long", size: "12.5" }] },
}

function ctx(opts: { payer?: PayerResult; typed?: boolean; perps?: "failed" | typeof PERPS_READ } = {}): CliPlanContext & { chains: (string | undefined)[] } {
  const chains: (string | undefined)[] = []
  return {
    chains,
    agent: "momentum",
    opId: OP_ID,
    payer: (_word, chain) => {
      chains.push(chain)
      return opts.payer ?? tee
    },
    ...(opts.typed ? { typed: true } : {}),
    readPerps: async () => (opts.perps === "failed" ? undefined : (opts.perps ?? PERPS_READ)),
    price: async () => undefined,
    readStaking: async () => undefined,
    dryRun: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    researchDir: tmpdir(),
    stage: new UploadStage(join(tmpdir(), "chrn-perps-unused")),
    refuse: async (code, message) => {
      throw new Refused(code, message)
    },
  }
}

/** A typed or proposed candle_cli call, resolved against the table, as the card book gets it. */
function request(words: string[]): CliCardRequest {
  const [command, sub, ...rest] = words
  const resolved = resolveCall({ command, subcommand: sub, args: rest }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`)
  const call = resolved.call
  return { row: call.row.path, words: call.argv, valueFlags: call.valueFlags, rpcUrl: call.withRpcUrl, yes: call.takesYes }
}

const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: Refused) => e.code)

describe("the table", () => {
  test("what lowers risk is a card held until perps.writes is on; opening risk and moving funds stay later", () => {
    for (const path of ["perps close", "perps cancel", "perps tpsl", "perps schedule-cancel", "perps flatten"]) {
      const row = rowFor(path)!
      expect(row).toMatchObject({ rule: "card", route: "card", identity: "agent" })
      expect(row.card).toMatchObject({ kind: "perps", wallet: "evm-tee", held: PERPS_HELD, lifts: "perps.writes" })
      expect(heldNow(row, false)).toBe(true)
      expect(heldNow(row, true)).toBe(false)
    }
    for (const path of ["perps open", "perps setup", "perps modify", "perps margin", "perps leverage", "perps deposit", "perps withdraw", "perps thresholds set", "perps reduce-only off"]) {
      expect(rowFor(path)!.route).toBe("later")
    }
    expect(rowFor("perps reduce-only on")).toMatchObject({ rule: "less-access", route: "cli", identity: "agent" })
    expect(rowFor("perps reduce-only")).toMatchObject({ rule: "read", route: "cli" })
    // Only a close takes an id, so only a close is read back by a rerun.
    expect(rowFor("perps close")!.card).toMatchObject({ idFlag: "--client-id", readBack: "rerun" })
    expect(rowFor("perps flatten")!.card!.readBack).toBe("none")
  })

  test("the agent never passes a dry run, a sign-only run, or another key's reduce-only", () => {
    expect(FORBIDDEN_FLAGS.has("--no-submit")).toBe(true)
    expect(FORBIDDEN_FLAGS.has("--sign-only")).toBe(true)
    const other = resolveCall({ command: "perps", subcommand: "reduce-only", args: ["on", "--key", "abcd1234"] }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
    expect(other.ok && other.call.rule).toBe("owner")
    const self = resolveCall({ command: "perps", subcommand: "reduce-only", args: ["on"] }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
    expect(self.ok && self.call.rule).toBe("less-access")
  })

  test("the tool's description says held when off and card when on", () => {
    const off = describeTool(false)
    const on = describeTool(true)
    const cardLine = (text: string) => text.split("\n").find((l) => l.startsWith("Becomes a one-press card for the user, run with your key"))!
    expect(cardLine(off)).not.toContain("perps close")
    const laterLine = (text: string) => text.split("\n").find((l) => l.startsWith("Later (perps writes)"))!
    // Off, the rows are said once, under Later, and reduce-only on isn't offered as a one-press narrowing.
    expect(laterLine(off)).toContain("close")
    expect(laterLine(off)).toContain("reduce-only on")
    expect(off).not.toContain("perps reduce-only on")
    expect(laterLine(on)).not.toContain("close")
    expect(on).toContain("perps reduce-only on")
    expect(cardLine(on)).toContain("perps close")
    expect(cardLine(on)).toContain("--remove-sl")
    expect(on).not.toContain("perps.writes = true")
  })

  test("Candle's own perps write tools stay refused and point at candle_cli", () => {
    const verdict = classify("candle_perps_close", {}, "live")
    expect(verdict.class).toBe("refused")
    expect(verdict.class === "refused" && verdict.reason).toContain("candle_cli")
  })
})

describe("the flatten card", () => {
  test("lists every resting order and position it will touch, read when the card is made", async () => {
    const plan = await planCliRow(request(["perps", "flatten"]), ctx())
    expect(plan.preview).toContain("cancels 2 open orders: BTC buy 0.1 @ 60000; ETH sell 2 @ 4000")
    expect(plan.preview).toContain("closes 1 position at market: SOL long 12.5")
  })
  test("says so when there is nothing to touch", async () => {
    const plan = await planCliRow(request(["perps", "flatten"]), ctx({ perps: { orders: { orders: [] }, positions: { rows: [] } } }))
    expect(plan.preview).toContain("no open orders")
    expect(plan.preview).toContain("no open positions")
  })
  test("is refused, nothing sent, when Hyperliquid's list can't be read: the card is the only gate", async () => {
    expect(await refusal(planCliRow(request(["perps", "flatten"]), ctx({ perps: "failed" })))).toBe("PERPS_READ_FAILED")
  })
})

describe("planning a card", () => {
  test("close binds the EVM TEE wallet by address, the card's cloid and --yes", async () => {
    const c = ctx()
    const plan = await planCliRow(request(["perps", "close", "BTC", "--pct", "50", "--wallet", "hl-one"]), c)
    expect(c.chains).toEqual(["hood"])
    expect(plan.argv).toEqual(["perps", "close", "BTC", "--pct", "50", "--wallet", EVM_TEE, "--client-id", cloidOf(OP_ID), "--yes"])
    expect(cloidOf(OP_ID)).toMatch(/^0x[0-9a-f]{32}$/)
    expect(plan.headline).toBe("CLOSE BTC 50%")
    expect(plan.wallet).toBe(EVM_TEE)
    expect(plan.side).toBeUndefined()
    expect(plan.usd).toBeUndefined()
  })

  test("no --wallet takes the agent's default on Hood, which must be an EVM TEE wallet", async () => {
    const plan = await planCliRow(request(["perps", "flatten"]), ctx())
    expect(plan.argv).toEqual(["perps", "flatten", "--wallet", EVM_TEE, "--yes"])
    expect(plan.headline).toBe("FLATTEN ALL PERPS")
    expect(await refusal(planCliRow(request(["perps", "flatten"]), ctx({ payer: embedded })))).toBe("EVM_TEE_WALLET_REQUIRED")
    expect(await refusal(planCliRow(request(["perps", "flatten", "--wallet", "embedded"]), ctx()))).toBe("EVM_TEE_WALLET_REQUIRED")
  })

  test("the core gives the id: an agent's --client-id is refused", async () => {
    expect(await refusal(planCliRow(request(["perps", "close", "BTC", "--client-id", CLOID]), ctx()))).toBe("CLIENT_ID_BY_HARNESS")
  })

  test("each row's words are checked before a card is made", async () => {
    const bad = [
      ["perps", "close", "BTC", "--size", "1", "--pct", "5"],
      ["perps", "close", "BTC", "--pct", "150"],
      ["perps", "close", "BTC/USD"],
      ["perps", "cancel", "123"],
      ["perps", "tpsl", "BTC"],
      ["perps", "tpsl", "BTC", "--take-profit", "70000", "--remove-tp"],
      ["perps", "schedule-cancel", "3"],
      ["perps", "schedule-cancel", "30", "--clear"],
    ]
    for (const words of bad) expect(await refusal(planCliRow(request(words), ctx()))).toBe("INVALID_PERPS")
    const cancel = await planCliRow(request(["perps", "cancel", CLOID]), ctx())
    expect(cancel.argv).toEqual(["perps", "cancel", CLOID, "--wallet", EVM_TEE, "--yes"])
    const timer = await planCliRow(request(["perps", "schedule-cancel", "60"]), ctx())
    expect(timer.preview).toContain("take-profit and stop-loss legs too")
    const clear = await planCliRow(request(["perps", "schedule-cancel", "--clear"]), ctx())
    expect(clear.headline).toBe("CLEAR PERPS CANCEL-ALL TIMER")
  })

  test("a TP/SL change names the protection gap; removing a stop-loss is the person's to type", async () => {
    const change = await planCliRow(request(["perps", "tpsl", "ETH", "--stop-loss", "2500"]), ctx())
    expect(change.headline).toBe("TP/SL ETH SL 2,500")
    expect(change.preview).toContain("a short gap with no protection")
    expect(await refusal(planCliRow(request(["perps", "tpsl", "ETH", "--remove-sl"]), ctx()))).toBe("INVALID_PERPS")
    const typed = await planCliRow(request(["perps", "tpsl", "ETH", "--remove-sl"]), ctx({ typed: true }))
    expect(typed.preview).toContain("no stop-loss")
  })
})

describe("how it ended", () => {
  const run = (exitCode: number, json: unknown) => ({ exitCode, timedOut: false, json })

  test("exit 0 goes through when it says so; a replayed close is read with candle perps orders", () => {
    expect(mapCliRow("perps close", run(0, { success: true, perpOrderId: "po_1", cloid: CLOID })).state).toBe("succeeded")
    expect(mapCliRow("perps flatten", run(0, { operation: "flatten", complete: true, steps: [] })).state).toBe("succeeded")
    expect(mapCliRow("perps close", run(0, { replayed: true, clientId: CLOID, status: "submitted" })).state).toBe("unknown")
    expect(mapCliRow("perps cancel", run(0, { success: true, signed: false, submitted: false })).state).toBe("unknown")
  })

  test("a refusal before anything was signed is refused; exit 3 and a plan's later step may have gone", () => {
    expect(mapCliRow("perps close", run(1, { code: "PERPS_BUILD_REFUSED", message: "Refused to sign this build" })).state).toBe("refused")
    expect(mapCliRow("perps cancel", run(1, { code: "PERPS_VENUE_REFUSED", message: "Hyperliquid refused it" })).state).toBe("refused")
    expect(mapCliRow("perps close", run(3, { code: "PERPS_SUBMIT_FAILED", message: "Signed, but the submit failed" })).state).toBe("unknown")
    // A plan: an error after its confirm may follow a step that went.
    expect(mapCliRow("perps flatten", run(1, { code: "PERPS_BUILD_REFUSED", message: "step 2" })).state).toBe("unknown")
    expect(mapCliRow("perps tpsl", run(1, { code: "PERPS_NO_POSITION", message: "No ETH position" })).state).toBe("refused")
    expect(mapCliRow("perps tpsl", run(1, { operation: "tpsl", complete: false, steps: [{ status: "confirmed" }] })).state).toBe("unknown")
  })
})

describe("the kill switch", () => {
  test("it stops setting a cancel-all timer, and keeps closes, cancels, TP/SL, flatten and clearing the timer", () => {
    const card = (row: string, argv?: string[]) => pausedStops({ kind: "perps", tool: "candle_cli", row, ...(argv ? { params: { argv } } : {}) })
    expect(card("perps schedule-cancel", ["perps", "schedule-cancel", "60", "--yes"])).toBe(true)
    expect(card("perps schedule-cancel", ["perps", "schedule-cancel", "--clear", "--yes"])).toBe(false)
    // Unread argv errs towards stopping.
    expect(card("perps schedule-cancel")).toBe(true)
    for (const row of ["perps close", "perps cancel", "perps tpsl", "perps flatten"]) expect(card(row, ["perps"])).toBe(false)
  })
})

describe("keys and the setting", () => {
  test("a key that can withdraw from Hyperliquid never lives in the Candle Harness; Trade perps does", () => {
    const at = { configured: new Set<string>(), maxAgents: 8 }
    expect(prepareKeysCreate(["keys", "create", "--label", "hl", "--scopes", "account:read,perps:write,perps:withdraw"], at)).toMatchObject({ ok: false, code: "NO_WITHDRAW_KEY" })
    expect(prepareKeysCreate(["keys", "create", "--label", "hl", "--access", "trade-perps"], at)).toMatchObject({ ok: true })
  })

  test("perps.writes is off unless set, takes true or false, and is in the settings table", () => {
    const p = paths({ HOME: mkdtempSync(join(tmpdir(), "chrn-perps-config-")) })
    mkdirSync(p.configDir, { recursive: true })
    const agent = `[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`
    const load = (extra: string) => {
      writeFileSync(p.configFile, `${agent}\n${extra}`)
      return loadConfig(p)
    }
    expect(load("").config.perps).toEqual({ writes: false })
    expect(load("[perps]\nwrites = true\n").config.perps).toEqual({ writes: true })
    expect(() => load(`[perps]\nwrites = "yes"\n`)).toThrow("perps.writes")
    expect(SETTINGS.find((s) => s.key === "perps.writes")).toMatchObject({ file: "config.toml", default: "false" })
  })
})
