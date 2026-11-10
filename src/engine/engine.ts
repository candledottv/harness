// The engine seam: what the runner needs from any harness. Each harness gets an adapter (claude.ts,
// codex.ts, grok.ts, opencode.ts, pi.ts), and everything above the seam stays one piece: the transcript
// the core keeps, the harness token and the MCP shim, the step cap, the address gate, secret refusal, the
// leftover check, cards, limits and the kill switch. An engine changes how a turn is run, never what the
// turn may do.
import { spawn } from "node:child_process"
import { withoutBunVars } from "../shared/bun-env"
import { resolveBin, withAbsolutePath } from "../shared/exec-path"
import { terminalText } from "../shared/terminal-text"
import type { Turn } from "./events"
import type { RunHooks } from "./spawn"
import type { ToolSettings } from "./tools"

export const ENGINE_IDS = ["claude-code", "codex", "grok", "opencode", "pi"] as const
export type EngineId = (typeof ENGINE_IDS)[number]

export const ENGINE_LABELS: Readonly<Record<EngineId, string>> = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok", opencode: "OpenCode", pi: "Pi" }

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value)
}

export type EngineCheck = { ok: true; version: string } | { ok: false; version?: string; message: string }

export interface EngineModel {
  /** What the harness's model flag takes. */
  id: string
  label: string
  /** The harness's own default, where it says. */
  isDefault?: boolean
}

export interface EngineCapabilities {
  webSearch: boolean
  webFetch: boolean
  /**
   * The engine's own file tools, held to the research folder: `own` reads and writes; `write` writes
   * only, and reads through the core's research tools (Codex with the shell off); `none` has no
   * file tools of its own on this platform.
   */
  files: "own" | "write" | "none"
  /** Whether a list of shell commands can be held; without it a list means off. */
  shellList: boolean
  /** Token deltas, rather than whole messages. */
  deltas: boolean
}

/** The MCP server a turn reaches Candle through: `candle-harness mcp --token-file …`. */
export interface McpServer {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface EngineTurn {
  /** The prompt: the transcript and the user's message. Never on a command line. */
  prompt: string
  /** The Candle trader prompt. */
  systemPrompt: string
  /** The agent's research folder: the engine's working folder, and the only one its file tools reach. */
  researchDir: string
  /** The turn's MCP config file (0600), naming the shim in Claude Code's shape; other engines read `mcp`. */
  mcpConfig: string
  mcp: McpServer
  /** The model picked; undefined runs the harness's own default. */
  model?: string
  env: Record<string, string>
  /** A private folder for this turn's engine files (homes, configs), under the core's state; removed after the turn. */
  workDir: string
  /**
   * The agent's shell and tool settings: each engine hides the research tools they don't offer
   * and maps the shell, a list being off where it can't hold one. Undefined is the shell off and every
   * research tool. Candle's tools are hidden by the core itself.
   */
  tools?: ToolSettings
}

export interface Engine {
  id: EngineId
  label: string
  minVersion: string
  /**
   * The newest version its holds were checked on. A harness updates itself between the Candle Harness's own
   * releases; a newer major version than this may have changed what its flags and sandbox do, and is said.
   */
  checkedVersion: string
  capabilities(platform?: NodeJS.Platform): EngineCapabilities
  /** Installed, its version, and whether it meets the minimum, with words for each failure. */
  check(env: Record<string, string>): Promise<EngineCheck>
  /** The models the user can run here. Never read on a turn's path. */
  models(env: Record<string, string>): Promise<EngineModel[]>
  /**
   * Whether the harness is signed in, asked of the harness or by whether its sign-in file exists, never
   * by reading it; undefined when it can't say. An engine without it (OpenCode, Pi)
   * is ready when its model list isn't empty.
   */
  signedIn?(env: Record<string, string>): Promise<boolean | undefined>
  /** What to run to sign in, or to add a model, in the picker's words. */
  signIn?: string
  /** A turn needs a model by name: with none picked and no default of the user's, no turn runs (OpenCode, Pi). */
  needsModel?: boolean
  /**
   * The model a turn with none picked runs on: the harness's own default from the list last read, passed
   * explicitly so the journal records what ran. Codex's stream never names the model that answered.
   * Undefined until a list has been read; an engine without it runs its own default.
   */
  defaultModel?(): string | undefined
  /**
   * Lines about models the list held back, from the list last read: a Claude, ChatGPT or Grok
   * subscription signed in through OpenCode or Pi, with the harness to use instead.
   */
  modelNotes?(): string[]
  start(turn: EngineTurn, hooks?: RunHooks): Turn
  /** A turn that ended without a reply, in words the person can act on. */
  explain(message: string | undefined): string
}

const majorOf = (version: string): number | undefined => {
  const m = /^(\d+)\./.exec(version)
  return m ? Number(m[1]) : undefined
}

/** Whether `version` is a newer major version than `checked`. A newer minor or patch never counts: harnesses ship those weekly. */
export function newerMajor(version: string | undefined, checked: string): boolean {
  const have = version === undefined ? undefined : majorOf(version)
  const known = majorOf(checked)
  return have !== undefined && known !== undefined && have > known
}

/** What's said of a harness on a newer major version than the one its holds were checked on. */
export const newerMajorWords = (label: string, version: string, checked: string): string =>
  `${label} is ${version}, a newer major version than the one its holds were checked on (${checked})`

export function engineRegistry(engines: readonly Engine[]): ReadonlyMap<EngineId, Engine> {
  const map = new Map<EngineId, Engine>()
  for (const e of engines) {
    if (map.has(e.id)) throw new Error(`The engine ${e.id} is registered twice`)
    map.set(e.id, e)
  }
  return map
}

/**
 * Whether `bin`, found on `env`'s PATH, is one of the stand-ins cmux puts on its terminals' PATH (`claude`, `codex`,
 * `pi`, `grok`). They hand on to the real harness, so one that gives no version means it isn't
 * installed. A turn never meets one's hooks: harnessEnv drops CMUX_SURFACE_ID, and they pass straight through.
 */
export function cmuxStandIn(bin: string, env: Record<string, string>): boolean {
  const path = bin.includes("/") ? bin : Bun.which(bin, { PATH: env.PATH ?? "" })
  return path !== null && /\/\.cmuxterm\/cmux-cli-shims\/|\/cmux\.app\/Contents\/Resources\/bin\//.test(path)
}

const VERSION_SHAPED = /\d+\.\d+\.\d+/

/** `<bin> <args> --version`'s output, without blocking the core; `missing` when there's no such binary, or only
 * cmux's stand-in for it. */
export function readVersion(bin: string, args: string[], env: Record<string, string>, timeoutMs = 15_000): Promise<{ out: string; missing?: true; said?: string }> {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let child
    try {
      child = spawn(resolveBin(bin, env.PATH), [...args, "--version"], { env: withoutBunVars(withAbsolutePath(env)), stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs })
    } catch {
      resolve({ missing: true, out: "" })
      return
    }
    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (s: string) => (out += s.slice(0, 4096)))
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (s: string) => (err += s.slice(0, 4096)))
    // Its own first line on stderr, for why a version couldn't be read (said, never parsed).
    const said = () => {
      const first = err.split("\n").map((l) => l.trim()).find(Boolean)
      return first ? { said: terminalText(first, { maxLength: 200 }) } : {}
    }
    child.on("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ENOENT" ? { missing: true, out: "" } : { out, ...said() }))
    child.on("close", () => resolve(!VERSION_SHAPED.test(out) && cmuxStandIn(bin, env) ? { missing: true, out } : { out, ...said() }))
  })
}

/** A version that couldn't be read, with what the harness said on stderr, where it said anything. */
export function withSaid<T extends { ok: boolean; message?: string; version?: string }>(check: T, said: string | undefined): T {
  if (check.ok || check.version || !said || !check.message?.startsWith("Couldn't read")) return check
  return { ...check, message: `${check.message.replace(/\.$/, "")}: it said "${said}".` }
}
