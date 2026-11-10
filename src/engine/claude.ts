// Claude Code as an engine: `claude -p` with stream-json output.
//
// Isolation: --restricted ignores the user's (and any project's) settings files, so their hooks,
// plugins and permission rules stay out; drops the shell and WebFetch unless --tools names them;
// confines the file tools to the working folder, which is the agent's research folder (reads as well
// as writes: the canary test checks it); and refuses to bypass permissions. Unlike --bare it keeps
// subscription sign-in. It also keeps a CLAUDE.md in a parent folder out (checked: the
// same run without it obeyed one). --strict-mcp-config limits MCP servers to ours, and
// --disable-slash-commands drops skills.
//
// What's on the command line is no secret: the system prompt there is the preset's fixed text, the mode
// and the data line; the prompt (the transcript, the user's message and the agent's memory) goes on
// stdin, so it never shows in a process list, and the harness token is in a 0600 file the turn's MCP
// config names.
import { spawnSync } from "node:child_process"
import { versionAtLeast } from "../core/candle-mcp"
import { cmuxStandIn, type Engine, type EngineCheck, type EngineTurn, type McpServer, readVersion, withSaid } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { modelOnce, sourceOf } from "./events"
import { type LineParser, type RunHooks, runLines, tryJson } from "./spawn"
import { DEFAULT_TOOLS, shellFor, type ToolSettings, toolAllowed } from "./tools"

/** `--restricted` arrived in 2.1.310. */
export const MIN_CLAUDE_CODE = "2.1.310"
/** The newest version its holds were checked on; a newer major version is said, never blocked. */
export const CHECKED_CLAUDE_CODE = "2.1.321"

/** The research set; the shell is the agent's setting, off unless it's turned on. */
export const CLAUDE_TOOLS = ["WebSearch", "WebFetch", "Read", "Write", "Edit"]

export interface ClaudeTurn {
  /** The `claude` binary: a name on PATH, or a path (config `engine.claude.path`). */
  bin: string
  /** The prompt, sent on stdin. */
  prompt: string
  /** The Candle trader prompt, appended to Claude Code's own. */
  systemPrompt: string
  /** The agent's research folder: the working folder, and the only one the file tools reach. */
  researchDir: string
  /** The turn's MCP config file (0600), naming `candle-harness mcp --token-file …`. */
  mcpConfig: string
  /** An alias or a full model id; undefined runs Claude Code's default. */
  model?: string
  env: Record<string, string>
  /** The agent's shell and tool settings. */
  tools?: ToolSettings
}

/**
 * The tools offered and those allowed to run. Hidden tools are left out of --tools; the shell is
 * `Bash` for everything, or `Bash(<entry>:*)` for each entry of a list, which Claude Code holds itself
 * (with `ls` listed, `ls` runs and `rm` is refused), and dontAsk refuses anything else.
 */
export function claudeTools(researchDir: string, t: ToolSettings = DEFAULT_TOOLS): { tools: string[]; allowed: string[] } {
  const on = (n: Parameters<typeof toolAllowed>[1]) => toolAllowed(t, n)
  const shell = shellFor(t, { shellList: true })
  const tools = [on("web_search") && "WebSearch", on("web_fetch") && "WebFetch", on("read") && "Read", ...(on("write") ? ["Write", "Edit"] : []), shell !== "off" && "Bash"].filter((x): x is string => typeof x === "string")
  const allowed = [
    "mcp__candle",
    ...tools.filter((x) => x === "WebSearch" || x === "WebFetch" || x === "Read"),
    ...(on("write") ? [`Write(/${researchDir}/**)`, `Edit(/${researchDir}/**)`] : []),
    ...(shell === "everything" ? ["Bash"] : shell === "off" ? [] : shell.map((e) => `Bash(${e}:*)`)),
  ]
  return { tools, allowed }
}

export function claudeArgs(o: Omit<ClaudeTurn, "prompt" | "env">): string[] {
  const { tools, allowed } = claudeTools(o.researchDir, o.tools)
  return [
    o.bin,
    "-p",
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--restricted", "--strict-mcp-config", "--mcp-config", o.mcpConfig, "--disable-slash-commands",
    "--append-system-prompt", o.systemPrompt,
    "--tools", tools.join(","),
    "--allowedTools", ...allowed,
    // Anything not allowed above is refused outright: print mode has nobody to ask.
    "--permission-mode", "dontAsk",
    // Engine turns stay out of the user's own session list; the core carries the conversation.
    "--no-session-persistence",
    ...(o.model ? ["--model", o.model] : []),
  ]
}

/** The turn's MCP server: only our shim, reaching this core. Every engine is given this one description. */
export function mcpServerFor(shim: string[], tokenFile: string, configDir: string): McpServer {
  return { command: shim[0]!, args: [...shim.slice(1), "mcp", "--token-file", tokenFile], env: { CANDLE_HARNESS_HOME: configDir } }
}

/** The MCP config a turn's file holds, in Claude Code's shape. */
export function mcpConfigFor(shim: string[], tokenFile: string, configDir: string): string {
  return JSON.stringify({ mcpServers: { candle: mcpServerFor(shim, tokenFile, configDir) } })
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : JSON.stringify(c))).join("\n")
  return JSON.stringify(content ?? "")
}

export function claudeParser(): LineParser {
  const names = new Map<string, string>()
  // Each message names the model that wrote it; a signed-out reply is Claude Code's own, "<synthetic>".
  const answered = modelOnce(["<synthetic>"])
  return (line) => {
    const m = tryJson(line)
    if (!m || typeof m !== "object") return []
    const out: EngineEvent[] = []
    if (m.type === "stream_event" && m.event?.type === "message_start") {
      out.push(...answered(m.event.message?.model))
    } else if (m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") {
      out.push({ type: "text", delta: String(m.event.delta.text ?? "") })
    } else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      out.push(...answered(m.message.model))
      for (const c of m.message.content) {
        if (c?.type !== "tool_use") continue
        names.set(c.id, c.name)
        out.push({ type: "tool_call", id: c.id, name: c.name, input: c.input })
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) {
        if (c?.type !== "tool_result") continue
        const name = names.get(c.tool_use_id) ?? "unknown"
        out.push({ type: "tool_result", id: c.tool_use_id, name, output: toolResultText(c.content), source: sourceOf(name), ...(c.is_error === true ? { failed: true as const } : {}) })
      }
    } else if (m.type === "result") {
      if (m.subtype === "success" && !m.is_error) out.push({ type: "done", text: String(m.result ?? "") })
      else out.push({ type: "error", message: `claude: ${String(m.result ?? m.subtype ?? "error")}`.slice(0, 500) })
    }
    return out
  }
}

export function startClaude(o: ClaudeTurn, hooks: RunHooks = {}): Turn {
  return runLines("Claude Code", claudeArgs(o), { cwd: o.researchDir, parse: claudeParser(), env: o.env, stdin: o.prompt, ...hooks })
}

export type ClaudeVersion = EngineCheck

/** `claude --version` ("2.1.310 (Claude Code)"), checked against the minimum; cmux's stand-in alone is missing. */
export function claudeVersion(bin: string, env: Record<string, string>): ClaudeVersion {
  const run = spawnSync(bin, ["--version"], { env, encoding: "utf8", timeout: 15_000 })
  const out = `${run.stdout ?? ""}`
  const missing = Boolean(run.error && (run.error as NodeJS.ErrnoException).code === "ENOENT") || (!/\d+\.\d+\.\d+/.test(out) && cmuxStandIn(bin, env))
  return judgeVersion(bin, out, missing)
}

function judgeVersion(bin: string, out: string, missing: boolean): ClaudeVersion {
  if (missing) return { ok: false, message: `Claude Code isn't installed (no "${bin}" found). Install it, sign in, and send your message again.` }
  const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  if (!version) return { ok: false, message: `Couldn't read Claude Code's version from "${bin} --version".` }
  if (!versionAtLeast(version, MIN_CLAUDE_CODE)) {
    return {
      ok: false,
      version,
      message: `Update Claude Code: this is ${version}, and the Candle Harness needs ${MIN_CLAUDE_CODE} or later for --restricted, which keeps your own settings, hooks and plugins out of the agent.`,
    }
  }
  return { ok: true, version }
}

/** Claude Code's aliases for the newest of each model; it has no command that lists models. */
const CLAUDE_MODELS = [
  { id: "fable", label: "Fable (newest)" },
  { id: "opus", label: "Opus (newest)" },
  { id: "sonnet", label: "Sonnet (newest)" },
  { id: "haiku", label: "Haiku (newest)" },
]

/** Claude Code behind the engine seam. */
export function claudeEngine(bin: string): Engine {
  return {
    id: "claude-code",
    label: "Claude Code",
    minVersion: MIN_CLAUDE_CODE,
    checkedVersion: CHECKED_CLAUDE_CODE,
    capabilities: () => ({ webSearch: true, webFetch: true, files: "own", shellList: true, deltas: true }),
    check: async (env) => {
      const r = await readVersion(bin, [], env)
      return withSaid(judgeVersion(bin, r.out, r.missing === true), r.said)
    },
    models: async () => CLAUDE_MODELS.map((m) => ({ ...m })),
    // `claude auth status` answers JSON, its own read of its own sign-in.
    signedIn: async (env) => {
      const run = Bun.spawn([bin, "auth", "status", "--json"], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      const timer = setTimeout(() => run.kill(), 15_000)
      try {
        const loggedIn = (tryJson(await new Response(run.stdout).text()) as { loggedIn?: unknown } | undefined)?.loggedIn
        return typeof loggedIn === "boolean" ? loggedIn : undefined
      } catch {
        return undefined
      } finally {
        clearTimeout(timer)
      }
    },
    signIn: "run claude, then /login",
    start: (turn: EngineTurn, hooks: RunHooks = {}) =>
      startClaude(
        { bin, prompt: turn.prompt, systemPrompt: turn.systemPrompt, researchDir: turn.researchDir, mcpConfig: turn.mcpConfig, env: turn.env, ...(turn.model ? { model: turn.model } : {}), ...(turn.tools ? { tools: turn.tools } : {}) },
        hooks,
      ),
    explain: (message) => {
      const m = message ?? "Claude Code ended without a reply."
      if (/not logged in|\/login|please run.*login/i.test(m)) return `Claude Code isn't signed in. Run claude in a terminal and sign in, then send your message again. (${m})`
      return m
    },
  }
}
