// Codex as an engine: `codex exec --json`.
//
// Isolation, from the user's own Codex setup:
//   - a private CODEX_HOME per turn (home.ts) holding only a link to the sign-in, since Codex reads the
//     user's AGENTS.md and skills from its home whatever the flags (a planted file showed both);
//   - --ignore-user-config skips their config.toml (MCP servers, profiles) and --ignore-rules their
//     exec-policy rules; --ephemeral keeps the turn out of their sessions;
//   - project_doc_max_bytes=0 and project_root_markers=[] keep out an AGENTS.md in the research folder
//     or any parent up to a git root, and skills.include_instructions=false every skill list, the
//     shared ~/.agents/skills included;
//   - plugins, hooks, apps, browser and computer use, image generation and viewing, multi-agent, skill
//     search, tool suggestions and goals are off, and the only MCP server is ours, pre-approved (with
//     approval "never", one that needed approval would fail rather than run).
//
// What it can reach: workspace-write holds writes to the research folder (its working root; /tmp and
// $TMPDIR excluded). With the shell off it has no tool that reads files at all, so it reads its
// notes through the core's research tools, and its prompt says so. Codex can't hold a list of shell
// commands, so a list means off, and the shell is on only for "everything". Then it runs in
// Codex's own sandbox: writes held to the research folder and no network, though it reads anything.
// A hidden web search is switched off; a hidden write can't be (Codex's patch tool has no switch), so
// the sandbox goes read-only and refuses it, and the prompt says there's no writing.
//
// Its stream names neither the model nor its version: the model always goes by -m (the one picked,
// else Codex's own default from its list), and `codex --version` runs under a private home, which runs
// the installed binary rather than an auto-updated copy.
//
// A rate-limited Codex waits up to eight minutes with nothing in its stream. It runs with its retry
// warnings on (RUST_LOG), and a wait over 30 s ends the turn with words. Signed out, it would retry ten
// times on a 401; the first ends the turn.
//
// What's on the command line is no secret: the prompt (the transcript, the user's message and the agent's
// memory) goes on stdin, and the harness token is in a 0600 file the shim reads.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { versionAtLeast } from "../core/candle-mcp"
import { type Engine, type EngineCheck, type EngineModel, type EngineTurn, type McpServer, readVersion, withSaid } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { sourceOf } from "./events"
import { privateHome } from "./home"
import { eventQueue, type LineParser, type RunHooks, runLines, tryJson } from "./spawn"
import { DEFAULT_TOOLS, shellFor, type ToolSettings, toolAllowed } from "./tools"

/** The version the read checks passed on. */
export const MIN_CODEX = "0.165.0"

/** Codex's retry warnings, the only place a rate limit's wait shows. */
export const CODEX_RETRY_LOG = "codex_core::responses_retry=warn"

/** A retry wait longer than this ends the turn rather than leaving the agent pane spinning. */
export const RETRY_LIMIT_MS = 30_000

/** Codex features a trading agent's turn has no use for, each a way in for the user's setup or a way out of the folder. */
export const CODEX_OFF = [
  "plugins",
  "hooks",
  "apps",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "computer_use",
  "image_generation",
  // Reads an image by any path, outside the research folder too.
  "view_image",
  "multi_agent",
  "skill_search",
  "tool_suggest",
  "goals",
]

/** The shell's features: off unless the agent's shell is "everything" (Codex can't hold a list). */
export const CODEX_SHELL = ["shell_tool", "unified_exec"]

const toml = (s: string) => JSON.stringify(s) // a JSON string is a valid TOML basic string

export interface CodexTurn {
  /** The `codex` binary: a name on PATH, or a path (config `engine.codex.path`). */
  bin: string
  /** The Candle trader prompt, as Codex's developer instructions. */
  systemPrompt: string
  /** The agent's research folder: the working root, and the only folder Codex may write in. */
  researchDir: string
  mcp: McpServer
  model?: string
  /** The agent's shell and tool settings. */
  tools?: ToolSettings
}

export function codexArgs(o: CodexTurn): string[] {
  const t = o.tools ?? DEFAULT_TOOLS
  const shell = shellFor(t, { shellList: false })
  const args = [o.bin, "exec", "--json", "-s", toolAllowed(t, "write") ? "workspace-write" : "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--ephemeral", "-C", o.researchDir]
  for (const f of [...CODEX_OFF, ...(shell === "everything" ? [] : CODEX_SHELL)]) args.push("--disable", f)
  const env = Object.entries(o.mcp.env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  args.push(
    // workspace-write also opens /tmp and $TMPDIR to writes by default (a turn wrote outside that way).
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c", 'approval_policy="never"',
    "-c", `web_search="${toolAllowed(t, "web_search") ? "live" : "disabled"}"`,
    "-c", "project_doc_max_bytes=0",
    "-c", "project_root_markers=[]",
    "-c", "skills.include_instructions=false",
    "-c", `developer_instructions=${toml(o.systemPrompt)}`,
    "-c", `mcp_servers.candle.command=${toml(o.mcp.command)}`,
    "-c", `mcp_servers.candle.args=[${o.mcp.args.map(toml).join(", ")}]`,
    ...env.flatMap(([k, v]) => ["-c", `mcp_servers.candle.env.${k}=${toml(v)}`]),
    "-c", 'mcp_servers.candle.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.candle.startup_timeout_sec=30",
    ...(o.model ? ["-m", o.model] : []),
    // The prompt is read from stdin.
    "-",
  )
  return args
}

function nameOf(item: any): string {
  switch (item.type) {
    case "mcp_tool_call":
      return `mcp__${item.server}__${item.tool}`
    case "web_search":
      return "web_search"
    case "command_execution":
      return "shell"
    case "file_change":
      return "file_change"
    default:
      return String(item.type)
  }
}

function inputOf(item: any): unknown {
  switch (item.type) {
    case "mcp_tool_call":
      return item.arguments
    case "web_search":
      return item.action ?? { query: item.query }
    case "command_execution":
      return { command: item.command }
    case "file_change":
      return { changes: item.changes }
  }
}

function outputOf(item: any): string {
  switch (item.type) {
    case "mcp_tool_call":
      if (item.error) return `error: ${item.error.message ?? JSON.stringify(item.error)}`
      return (item.result?.content ?? []).map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c))).join("\n")
    case "web_search":
      return JSON.stringify(item.results ?? [])
    case "command_execution":
      return `${item.aggregated_output ?? ""}${item.exit_code === undefined || item.exit_code === null ? "" : `\n(exit ${item.exit_code})`}`
    case "file_change":
      return JSON.stringify(item.changes ?? [])
    default:
      return JSON.stringify(item)
  }
}

const TOOL_ITEMS = new Set(["mcp_tool_call", "web_search", "command_execution", "file_change"])

const SIGNED_OUT = "Codex isn't signed in. Run codex login in a terminal (codex login --device-auth over SSH), then send your message again."
const isUnauthorized = (message: string) => /\b401\b|Unauthorized/.test(message)

export function codexParser(): LineParser {
  const called = new Set<string>()
  let lastMessage = ""
  return (line) => {
    const m = tryJson(line)
    if (!m || typeof m !== "object") return []
    const item = m.item
    if ((m.type === "item.started" || m.type === "item.completed") && item && typeof item === "object" && TOOL_ITEMS.has(item.type)) {
      const out: EngineEvent[] = []
      if (!called.has(item.id)) {
        called.add(item.id)
        out.push({ type: "tool_call", id: item.id, name: nameOf(item), input: inputOf(item) })
      }
      if (m.type === "item.completed") {
        const name = nameOf(item)
        const failed = item.status === "failed" || item.status === "declined" || !!item.error
        out.push({ type: "tool_result", id: item.id, name, output: outputOf(item), source: sourceOf(name), ...(failed ? { failed: true as const } : {}) })
      }
      return out
    }
    if (m.type === "item.completed" && item?.type === "agent_message") {
      lastMessage = String(item.text ?? "")
      return [{ type: "text", delta: `${lastMessage}\n\n` }]
    }
    if (m.type === "turn.completed") return [{ type: "done", text: lastMessage }]
    if (m.type === "turn.failed") {
      const message = String(m.error?.message ?? "turn failed")
      if (isUnauthorized(message)) return [{ type: "error", message: SIGNED_OUT }]
      return [{ type: "error", message: `codex: ${message}`.slice(0, 500) }]
    }
    // Top-level "error" lines are retry notices ("Reconnecting... 2/5"); a real failure ends with
    // turn.failed. A 401 among them is a sign-in that retrying won't fix, so it ends the turn now.
    if (m.type === "error" && isUnauthorized(String(m.message ?? ""))) return [{ type: "error", message: SIGNED_OUT }]
    // Also ignored: thread.started, turn.started, reasoning, warning and error items, anything new.
    return []
  }
}

const UNITS: Record<string, number> = { ns: 1e-6, "µs": 1e-3, us: 1e-3, ms: 1, s: 1000 }

/** Codex's retry warning on stderr: a wait over the limit ends the turn, once, with how long it would be. */
export function codexStderr(limitMs = RETRY_LIMIT_MS): LineParser {
  let said = false
  return (line) => {
    if (said) return []
    const m = /retrying sampling request \((\d+)\/(\d+) in ([\d.]+)(ns|µs|us|ms|s)\)/.exec(line)
    if (!m) return []
    const ms = Number(m[3]) * UNITS[m[4]!]!
    if (!(ms > limitMs)) return []
    said = true
    const wait = ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
    const why = /\b429\b|Too Many Requests|rate.?limit/i.test(line) ? "Codex is rate-limited" : "Codex lost its connection"
    return [{ type: "error", message: `${why}: its next try would be in ${wait}, so this turn stopped. Pick another engine with ctrl-g, or send your message again later.` }]
  }
}

/** `codex debug models`: the models Codex shows in its own picker, in its order, the first its default. */
export function codexModels(json: string): EngineModel[] {
  let parsed: any
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const listed = (Array.isArray(parsed?.models) ? parsed.models : [])
    .filter((m: any) => m && typeof m.slug === "string" && m.visibility === "list")
    .map((m: any, i: number) => ({ m, i }))
    .sort((a: any, b: any) => (Number(a.m.priority) || 0) - (Number(b.m.priority) || 0) || a.i - b.i)
  return listed.map(({ m }: any, i: number) => ({ id: m.slug, label: typeof m.display_name === "string" ? m.display_name : m.slug, ...(i === 0 ? { isDefault: true } : {}) }))
}

function judgeVersion(bin: string, out: string, missing: boolean): EngineCheck {
  if (missing) return { ok: false, message: `Codex isn't installed (no "${bin}" found). Install it with npm install -g @openai/codex, sign in with codex login, and send your message again.` }
  const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  if (!version) return { ok: false, message: `Couldn't read Codex's version from "${bin} --version".` }
  if (!versionAtLeast(version, MIN_CODEX)) {
    return { ok: false, version, message: `Update Codex: this is ${version}, and the Candle Harness needs ${MIN_CODEX} or later, the version its isolation and read hold were checked on.` }
  }
  return { ok: true, version }
}

/** A turn that ended before Codex could start, with words. */
function failed(message: string): Turn {
  const q = eventQueue()
  q.push({ type: "error", message })
  q.end()
  return { events: q.iterate(), cancel: async () => {} }
}

/**
 * Codex behind the engine seam. `homesDir` is the core's (state/homes), where every private home lives
 * and a dead core's are recovered from; `codexHome` is the user's own CODEX_HOME when they set one.
 */
export function codexEngine(bin: string, o: { homesDir: string; codexHome?: string }): Engine {
  let defaultModel: string | undefined
  const realAuth = (env: Record<string, string>) => join(o.codexHome ?? join(env.HOME ?? "", ".codex"), "auth.json")
  const scratch = (what: string) => `${what}-codex-${randomBytes(6).toString("hex")}`
  return {
    id: "codex",
    label: "Codex",
    minVersion: MIN_CODEX,
    capabilities: () => ({ webSearch: true, webFetch: false, files: "write", shellList: false, deltas: false }),
    // Whether its sign-in file is there; the Candle Harness never reads it.
    signedIn: async (env) => existsSync(realAuth(env)),
    signIn: "codex login, or codex login --device-auth over SSH",
    check: async (env) => {
      // An empty private home: Codex writes into whatever CODEX_HOME it's given, even for --version.
      const home = join(o.homesDir, scratch("check"))
      mkdirSync(home, { recursive: true, mode: 0o700 })
      try {
        const r = await readVersion(bin, [], { ...env, CODEX_HOME: home })
        return withSaid(judgeVersion(bin, r.out, r.missing === true), r.said)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
    models: async (env) => {
      const home = privateHome({ base: o.homesDir, name: scratch("models"), realAuth: realAuth(env) })
      try {
        const run = Bun.spawn([bin, "debug", "models"], { env: { ...env, CODEX_HOME: home.home }, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
        const timer = setTimeout(() => run.kill(), 30_000)
        const out = await new Response(run.stdout).text()
        clearTimeout(timer)
        await run.exited
        const models = codexModels(out)
        if (models[0]) defaultModel = models[0].id
        return models
      } catch {
        return []
      } finally {
        home.close()
      }
    },
    defaultModel: () => defaultModel,
    start: (turn: EngineTurn, hooks: RunHooks = {}) => {
      const env = hooks.env ?? turn.env
      let home
      try {
        // Beside the turn's own folder, under the core's homes, so a dead core's is recovered on the next start.
        home = privateHome({ base: dirname(turn.workDir), name: `${basename(turn.workDir)}-codex`, realAuth: realAuth(env) })
      } catch (error) {
        return failed(`Codex couldn't start: its private home couldn't be made (${(error as Error).message}).`)
      }
      return runLines("Codex", codexArgs({ bin, systemPrompt: turn.systemPrompt, researchDir: turn.researchDir, mcp: turn.mcp, ...(turn.model ? { model: turn.model } : {}), ...(turn.tools ? { tools: turn.tools } : {}) }), {
        cwd: turn.researchDir,
        parse: codexParser(),
        stderr: codexStderr(),
        endOnError: true,
        env: { ...env, CODEX_HOME: home.home, RUST_LOG: CODEX_RETRY_LOG },
        stdin: turn.prompt,
        ...(hooks.onRaw ? { onRaw: hooks.onRaw } : {}),
        onExit: home.close,
      })
    },
    explain: (message) => {
      const m = message ?? "Codex ended without a reply."
      if (m !== SIGNED_OUT && isUnauthorized(m)) return `${SIGNED_OUT} (${m})`
      return m
    },
  }
}
