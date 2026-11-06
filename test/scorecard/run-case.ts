// Runs one scorecard case on one engine through a real core, the real shim, the fake Candle and the fake
// Hacc, and reads its record back from the core: the journal's agent.turn, card and memory rows, the
// agent topic's tool calls, memory/index.md, and the routes the fake Hacc was asked for.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Config } from "../../src/config"
import type { CoreOptions } from "../../src/core/core-main"
import type { Engine, EngineId } from "../../src/engine/engine"
import { AGENT_KEY, startTestCore, type TestCore, testEngine, until } from "../core-fixture"
import { type FakeHacc, startFakeHacc } from "../fake-hacc"
import { type Case, type CaseRecord, type Check, MOON, MOON_TWIN, PEPE, type TurnRecord } from "./cases"

export const OPENROUTER_KEY_FILE = join(homedir(), ".config/candle-harness-engines/openrouter-key")
const TURN_MS = 300_000
/**
 * Hacc's market read for the fake Candle's two tokens, in step with its figures (fake-candle-mcp.ts's
 * FAKE_PRICES_USD and market read), so a careful model doesn't find two sources disagreeing about one
 * mint. The rest of each answer is the recorded one's.
 */
const HACC_TOKENS = {
  [MOON]: { market: { symbol: "MOON", name: "MOON", price: 0.63, market_cap: 1_000_000, fdv: 1_000_000, liquidity: 100_000 } },
  [PEPE]: { market: { symbol: "PEPE", name: "PEPE", price: 0.165, market_cap: 1_000_000, fdv: 1_000_000, liquidity: 100_000 } },
  [MOON_TWIN]: { market: { symbol: "MOON", name: "MOON", price: 0.0021, market_cap: 1_000_000, fdv: 1_000_000, liquidity: 100_000 } },
}

// Planted rows' account: the core reads it from state/account, so its journal takes them as its own.
const ACCOUNT = "acct_scorecard0000000000"

export interface EngineSpec {
  engine: EngineId
  /** The model picked, as the picker would; the harness's own default when unset (the doctor's pick). */
  model?: string
  /** OpenCode and Pi run on the OpenRouter key, in a throwaway sign-in folder. */
  openrouter?: boolean
}

export interface CaseResult {
  id: string
  pass: boolean
  checks: Check[]
  /** Model-chosen details logged, not scored: whether a skill was read, the tools called. */
  notes: { skillRead: boolean; tools: string[]; figures: number; marked: number; ms: number }
  turns: { user: string; reply: string; outcome: string }[]
  /** What the core recorded, so a change to a case's scoring re-scores the same replies (report.ts). */
  record?: CaseRecord
  /** The model each turn answered on, as the journal has it. */
  ran?: { engine: string; engineVersion: unknown; model: unknown; answeredModel: unknown }
  error?: string
}

/**
 * The env and folders an engine needs to run on the OpenRouter key: one folder for the whole run, as a
 * person has one data home. A fresh one per case had the core's background model read race the turn to
 * make OpenCode's database ("database is locked"), which a person's existing folder never does.
 */
const signIns = new Map<string, { env: Record<string, string>; done: () => void }>()
function signIn(spec: EngineSpec): { env: Record<string, string> } {
  if (!spec.openrouter) return { env: {} }
  const kept = signIns.get(spec.engine)
  if (kept) return kept
  const made = makeSignIn(spec)
  signIns.set(spec.engine, made)
  return made
}

/** Removes the run's sign-in folders. */
export function signOut(): void {
  for (const s of signIns.values()) s.done()
  signIns.clear()
}

function makeSignIn(spec: EngineSpec): { env: Record<string, string>; done: () => void } {
  const key = readFileSync(OPENROUTER_KEY_FILE, "utf8").trim()
  mkdirSync(join(homedir(), ".cache"), { recursive: true })
  const dir = mkdtempSync(join(homedir(), ".cache/chrn-score-"))
  const done = () => rmSync(dir, { recursive: true, force: true })
  if (spec.engine === "pi") {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key } }), { mode: 0o600 })
    return { env: { PI_CODING_AGENT_DIR: dir }, done }
  }
  if (spec.engine === "opencode") {
    mkdirSync(join(dir, "opencode"), { mode: 0o700 })
    writeFileSync(join(dir, "opencode/auth.json"), JSON.stringify({ openrouter: { type: "api", key } }), { mode: 0o600 })
    return { env: { XDG_DATA_HOME: dir }, done }
  }
  throw new Error(`${spec.engine} doesn't run on OpenRouter here`)
}

/** Each engine on its own command name, as installed; a test's scripted engines are registered over them. */
const liveEngines: Config["engine"] = { ...testEngine, claude: { path: "claude" }, codex: { path: "codex" }, grok: { path: "grok" }, opencode: { path: "opencode" }, pi: { path: "pi" } }

/** The journal rows a planted history writes, each turn at noon of its day, in this machine's time. */
function plantedRows(c: Case): string {
  return (c.history ?? [])
    .map((t, i) => {
      const at = new Date(`${t.day}T12:00:00`)
      at.setSeconds(i)
      return JSON.stringify({ seq: i + 1, at: at.toISOString(), account: ACCOUNT, type: "agent.turn", mode: "live", agent: "momentum", turnId: `planted-${i + 1}`, user: t.user, reply: t.reply, tools: [], outcome: "done", steps: 0, reasked: false, engine: "claude-code", model: null, preset: "quant" })
    })
    .join("\n")
}

export async function runCase(
  c: Case,
  spec: EngineSpec,
  o: { engines?: Engine[]; onRaw?: (line: string) => void; turnMs?: number } = {},
): Promise<CaseResult> {
  const started = Date.now()
  const plan = c.plan ?? "max"
  const hacc: FakeHacc | undefined = c.haccOff ? undefined : startFakeHacc({ keys: [AGENT_KEY], plan, fail: c.hacc ?? {}, tokens: HACC_TOKENS })
  const sign = o.engines ? { env: {} } : signIn(spec)
  let core: TestCore | undefined
  try {
    const opts: Partial<CoreOptions> = {
      env: { ...process.env, ...sign.env },
      ...(hacc ? { haccHost: hacc.url } : {}),
      engine: { ...(o.engines ? { engines: o.engines, processes: () => [], leftoverDelayMs: 10 } : {}), ...(o.onRaw ? { onRaw: o.onRaw } : {}) },
      ...(o.engines ? { shim: ["/opt/candle-harness"] } : {}),
    }
    mkdirSync(join(homedir(), ".cache"), { recursive: true })
    core = await startTestCore(opts, {
      // Outside /tmp, which every Grok profile reads.
      prefix: join(homedir(), ".cache/chrn-h-"),
      config: { mode: "live", engine: { ...(o.engines ? testEngine : liveEngines), default: spec.engine }, hacc: { enabled: !c.haccOff } },
      candle: { momentum: { tier: plan, ...c.candle } },
      before: (p) => {
        if (c.memory !== undefined) {
          mkdirSync(join(p.researchDir("momentum"), "memory"), { recursive: true, mode: 0o700 })
          writeFileSync(join(p.researchDir("momentum"), "memory", "index.md"), c.memory)
        }
        if (c.history?.length) {
          mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
          writeFileSync(join(p.stateDir, "account"), `${ACCOUNT}\n`, { mode: 0o600 })
          writeFileSync(p.journal, `${plantedRows(c)}\n`, { mode: 0o600 })
        }
      },
    })
    const view = await core.view()
    await view.request("subscribe", { topics: ["agent", "autonomy"] })
    if (c.autonomy) {
      // The person's setting, from the main view, once the embedded wallet is read.
      await until(() => view.events.some((e) => e.topic === "autonomy" && (e.data as { wallets: { kind?: string }[] }).wallets.some((w) => w.kind === "embedded")), 30_000)
      const set = await view.request("autonomy.set", { wallet: "embedded", setting: "inside", ...c.autonomy })
      if (set.error) throw new Error(`autonomy.set refused: ${JSON.stringify(set.error)}`)
    }
    await until(() => core!.core.engine.lastCheck(spec.engine) !== undefined, 60_000)
    const check = core.core.engine.lastCheck(spec.engine)
    if (!check?.ok) throw new Error(`${spec.engine} didn't pass its check: ${JSON.stringify(check)}`)
    // The model list read in the background, before a turn shares its folders.
    await view.request("engine.models", { engine: spec.engine })
    if (spec.model) {
      const chose = await view.request("engine.choose", { agent: "momentum", engine: spec.engine, model: spec.model })
      if (chose.error) throw new Error(`couldn't pick ${spec.model}: ${JSON.stringify(chose.error)}`)
    }
    const events = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot).map((e) => e.data as Record<string, unknown>)
    const ended = () => events().filter((e) => e.type === "ended").length
    const turnTools: string[][] = []
    for (const text of c.turns) {
      const before = ended()
      const from = events().length
      const sent = await view.request("agent.send", { text })
      if (sent.error) throw new Error(`agent.send refused: ${JSON.stringify(sent.error)}`)
      await until(() => ended() > before, o.turnMs ?? TURN_MS)
      turnTools.push(events().slice(from).filter((e) => e.type === "tool_call").map((e) => String(e.name)))
    }
    // The memory row lands after the turn's own row.
    await Bun.sleep(50)

    const rows = core.core.journal.rows().filter((r) => r.agent === "momentum" && !String(r.turnId ?? "").startsWith("planted-"))
    const turnRows = rows.filter((r) => r.type === "agent.turn")
    const turns: TurnRecord[] = turnRows.map((r, i) => ({
      user: String(r.user),
      reply: String(r.reply),
      outcome: String(r.outcome),
      tools: turnTools[i] ?? [],
      reasked: r.reasked === true,
      figures: Number(r.figures ?? 0),
      marked: Array.isArray(r.marked) ? (r.marked as { text: string }[]).map((m) => m.text) : [],
    }))
    const harness = (r: Record<string, unknown>) => r.role === "harness"
    const approvedHow = new Map(rows.filter((r) => r.type === "card.approved").map((r) => [String(r.cardId), String(r.how)]))
    const record: CaseRecord = {
      turns,
      cards: rows
        .filter((r) => (r.type === "card.created" || r.type === "card.refused") && harness(r))
        .map((r) => ({
          state: r.type === "card.created" ? ("created" as const) : ("refused" as const),
          tool: String(r.tool),
          ...(typeof r.kind === "string" ? { kind: r.kind } : {}),
          ...(typeof r.side === "string" ? { side: r.side } : {}),
          ...(typeof r.mint === "string" ? { mint: r.mint } : {}),
          params: (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>,
          ...(approvedHow.has(String(r.cardId)) ? { how: approvedHow.get(String(r.cardId)) } : {}),
        })),
      ...(() => {
        const dir = join(core!.p.researchDir("momentum"), "memory")
        if (!existsSync(join(dir, "index.md"))) return {}
        const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile() && !(f.parentPath === dir && f.name === "index.md"))
        const memoryFiles = Object.fromEntries(files.map((f) => [join(f.parentPath, f.name).slice(dir.length + 1), readFileSync(join(f.parentPath, f.name), "utf8")]))
        return { memory: readFileSync(join(dir, "index.md"), "utf8"), memoryFiles }
      })(),
      memoryChanges: rows.filter((r) => r.type === "memory.change" && r.by === "agent").length,
      hacc: (hacc?.calls ?? []).map((k) => `${k.method} ${k.path}`),
    }
    const checks = c.score(record)
    const lastRow = turnRows.at(-1)
    const tools = turns.flatMap((t) => t.tools)
    return {
      id: c.id,
      pass: checks.every((k) => k.pass),
      checks,
      notes: {
        skillRead: tools.some((t) => t.includes("skill_read")),
        tools,
        figures: turns.reduce((n, t) => n + t.figures, 0),
        marked: turns.reduce((n, t) => n + t.marked.length, 0),
        ms: Date.now() - started,
      },
      turns: turns.map((t) => ({ user: t.user, reply: t.reply, outcome: t.outcome })),
      record,
      ...(lastRow ? { ran: { engine: String(lastRow.engine), engineVersion: lastRow.engineVersion, model: lastRow.model, answeredModel: lastRow.answeredModel } } : {}),
    }
  } catch (error) {
    // A case that couldn't run is a failure with its reason, never a pass.
    return { id: c.id, pass: false, checks: [], notes: { skillRead: false, tools: [], figures: 0, marked: 0, ms: Date.now() - started }, turns: [], error: String(error instanceof Error ? error.message : error) }
  } finally {
    await core?.close().catch(() => {})
    hacc?.stop()
  }
}
