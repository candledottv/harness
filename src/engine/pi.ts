// Pi as an engine: `pi --mode json -p`, one process per turn. Pi is the light engine, for OpenRouter, API
// keys and local models.
//
// Isolation, from the user's own Pi setup: Pi keeps all of it in one folder (~/.pi/agent: settings,
// extensions, skills, prompts, AGENTS.md, SYSTEM.md, mcp.json, models.json, auth.json), and
// PI_CODING_AGENT_DIR moves it. Each turn gets a private one in its work folder holding:
//   - auth.json: a link to the user's own. Pi writes it in place, so a refreshed sign-in lands in the
//     real file and nothing is handed back;
//   - models.json and models-store.json: copies of the user's own, so their local and custom endpoints
//     and stored catalogs work, with any local server found running added to the copy only;
//   - mcp.json: our Candle server alone, its tools declared directly (no codemode);
//   - settings.json: project trust "never".
// The flags turn the rest off: extensions (then our gate and Pi's MCP client back on alone), skills,
// prompt templates, themes, AGENTS.md and CLAUDE.md, project files and the session. PI_OFFLINE,
// PI_SKIP_VERSION_CHECK and PI_TELEMETRY=0 keep Pi from calling home.
//
// The read hold is ours (pi-gate.ts), since Pi has no sandbox: its file tools are held to the research
// folder, and every tool but those, Candle's and web_fetch is refused. The shell (`bash`) is the agent's
// setting: off, everything, or a list the gate holds. Our system prompt replaces Pi's
// coding-assistant one.
//
// Models come from `pi --list-models` in a private folder like a turn's, so the list is what a turn can
// run. A Claude, ChatGPT or Grok subscription signed in through Pi isn't offered, read
// from `pi auth check`'s kind, never from auth.json. A key held only in an environment variable doesn't
// reach Pi, since a harness's environment is cut down: Pi's /login stores one it can use.
//
// What's on the command line is no secret: the prompt (the transcript, the user's message and the agent's
// memory) goes on stdin, and the harness token is in a 0600 file the shim reads.
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
// Pi loads the gate from a file, so the binary carries its source as text. Nothing else in src
// imports it as a module, or the bundler would refuse the text import.
// @ts-expect-error a text import of a module
import GATE_SOURCE from "./pi-gate.ts" with { type: "text" }
import { versionAtLeast } from "../core/candle-mcp"
import { type Engine, type EngineCheck, type EngineModel, type EngineTurn, type McpServer, readVersion, withSaid } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { modelOnce, sourceOf } from "./events"
import { removeAll } from "./home"
import { eventQueue, type LineParser, type RunHooks, runLines, tryJson } from "./spawn"
import { DEFAULT_TOOLS, RESEARCH_NAMES, type ResearchName, shellFor, type ToolSettings, toolAllowed } from "./tools"

/** The version the gate and the read checks were checked on. */
export const MIN_PI = "1.4.0"

/** The research set: Pi's file tools and the gate's web_fetch. Candle's are `mcp__candle__*`. */
export const PI_TOOLS = ["read", "write", "edit", "ls", "web_fetch"]

/** Pi's tools for each research name. */
const PI_NAMES: Record<ResearchName, string[]> = { read: ["read", "ls"], write: ["write", "edit"], web_fetch: ["web_fetch"], web_search: [] }

/** The research tools a turn offers, after the agent's settings. */
export function piTools(t: ToolSettings = DEFAULT_TOOLS): string[] {
  return PI_TOOLS.filter((x) => !RESEARCH_NAMES.some((n) => PI_NAMES[n].includes(x) && !toolAllowed(t, n)))
}

/**
 * What the gate reads: the shell setting, which it holds by the same rule as tools.ts's, and
 * the research tools offered when the agent's settings hide any.
 */
export function piGateEnv(t: ToolSettings = DEFAULT_TOOLS): Record<string, string> {
  const shell = shellFor(t, { shellList: true })
  const offered = piTools(t)
  return {
    ...(shell !== "off" ? { CANDLE_GATE_SHELL: shell === "everything" ? "everything" : JSON.stringify(shell) } : {}),
    ...(offered.length < PI_TOOLS.length ? { CANDLE_GATE_TOOLS: offered.join(",") } : {}),
  }
}

/** Subscriptions that run through their own harness only, by Pi's provider id. `openai-codex` is only ever a ChatGPT sign-in. */
const SUBSCRIPTIONS: Record<string, { plan: string; harness: string }> = {
  anthropic: { plan: "Claude", harness: "Claude Code" },
  openai: { plan: "ChatGPT", harness: "Codex" },
  "openai-codex": { plan: "ChatGPT", harness: "Codex" },
  xai: { plan: "SuperGrok", harness: "Grok" },
}

/** Local servers offered when one answers on its usual port and the user's models.json doesn't already name it. */
export const LOCAL_SERVERS = [
  { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
]
export type LocalServer = (typeof LOCAL_SERVERS)[number]

/** Providers added to a turn's models.json copy: local servers found running. */
export type Providers = Record<string, { name: string; baseUrl: string; api: string; apiKey: string; models: { id: string; name: string }[] }>

/** `provider/model`, as Pi's --model takes it; the model's own id may hold slashes (openrouter/vendor/model). */
export function splitModel(id: string): { provider: string; model: string } | undefined {
  const at = id.indexOf("/")
  if (at <= 0 || at === id.length - 1) return undefined
  return { provider: id.slice(0, at), model: id.slice(at + 1) }
}

/** The user's own models.json, parsed; empty when there's none or Pi itself would refuse it. */
function userModels(userDir: string): { providers?: Record<string, { baseUrl?: unknown }> } {
  try {
    return JSON.parse(readFileSync(join(userDir, "models.json"), "utf8"))
  } catch {
    return {}
  }
}

/**
 * A private agent directory for one Pi run: the user's sign-in linked, their models copied (plus `extra`),
 * our MCP server alone, and project trust never. `mcp` undefined leaves MCP out (a models read).
 */
export function privateAgentDir(o: { userDir: string; dir: string; mcp?: McpServer; extra?: Providers }): void {
  mkdirSync(o.dir, { recursive: true, mode: 0o700 })
  const auth = join(o.userDir, "auth.json")
  // A second run in the same turn (the address gate's re-ask) finds the first run's link: it's made again.
  rmSync(join(o.dir, "auth.json"), { force: true })
  if (existsSync(auth)) symlinkSync(auth, join(o.dir, "auth.json"))
  const models = join(o.userDir, "models.json")
  if (o.extra && Object.keys(o.extra).length) {
    const user = userModels(o.userDir)
    writeFileSync(join(o.dir, "models.json"), JSON.stringify({ ...user, providers: { ...o.extra, ...user.providers } }), { mode: 0o600 })
  } else if (existsSync(models)) copyFileSync(models, join(o.dir, "models.json"))
  const store = join(o.userDir, "models-store.json")
  if (existsSync(store)) copyFileSync(store, join(o.dir, "models-store.json"))
  const servers = o.mcp ? { candle: { command: o.mcp.command, args: o.mcp.args, env: o.mcp.env, exposure: "direct" } } : {}
  writeFileSync(join(o.dir, "mcp.json"), JSON.stringify({ autoEnableCodemode: false, mcpServers: servers }), { mode: 0o600 })
  writeFileSync(join(o.dir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }), { mode: 0o600 })
}

export function piArgs(o: { bin: string; gateFile: string; model: string; systemPrompt: string; tools?: ToolSettings }): string[] {
  const shell = shellFor(o.tools ?? DEFAULT_TOOLS, { shellList: true })
  return [
    o.bin,
    "--mode", "json", "-p",
    "--no-session",
    // Discovery off (the user's extensions, skills, templates, themes, instruction files, project files),
    // then Pi's MCP client and our gate back on alone.
    "--no-extensions", "-e", "builtin:mcp", "-e", o.gateFile,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--model", o.model,
    "--tools", [...piTools(o.tools), ...(shell !== "off" ? ["bash"] : []), "mcp__candle__*"].join(","),
    // Ours replaces Pi's coding-assistant prompt, which also points the model at Pi's own docs.
    "--system-prompt", o.systemPrompt,
  ]
}

/** Pi's environment: its private agent folder, and nothing calling home. */
export function piEnv(env: Record<string, string>, agentDir: string): Record<string, string> {
  return { ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : "")).join("") : ""

const otherModel = (ran: string, picked: string) => `Pi answered on ${ran}, not ${picked}, so the turn stopped before anything it did counted. Pick the model again with ctrl-g.`

/** Pi's JSON events. `model` is the one picked: an assistant message on any other ends the turn. */
export function piParser(o: { model?: string } = {}): LineParser {
  let lastAssistant = ""
  let lastError: string | undefined
  let ended = false
  const answered = modelOnce()
  const end = (e: EngineEvent): EngineEvent[] => {
    ended = true
    return [e]
  }
  return (line) => {
    const m = tryJson(line)
    if (ended || !m || typeof m !== "object" || typeof m.type !== "string") return []
    switch (m.type) {
      case "message_update":
        return m.assistantMessageEvent?.type === "text_delta" ? [{ type: "text", delta: String(m.assistantMessageEvent.delta ?? "") }] : []
      case "tool_execution_start":
        // A call another tool made isn't the model's; none of the research set makes one.
        if (m.parentToolCallId) return []
        return [{ type: "tool_call", id: String(m.toolCallId), name: String(m.toolName), input: m.args }]
      case "tool_execution_end": {
        if (m.parentToolCallId) return []
        const name = String(m.toolName)
        const text = textOf(m.result?.content)
        return [{ type: "tool_result", id: String(m.toolCallId), name, output: m.isError ? `error: ${text}` : text, source: sourceOf(name), ...(m.isError ? { failed: true as const } : {}) }]
      }
      case "message_end": {
        const msg = m.message
        if (msg?.role !== "assistant") return []
        const ran = typeof msg.provider === "string" && typeof msg.model === "string" ? `${msg.provider}/${msg.model}` : undefined
        if (o.model && ran && ran !== o.model) return [...answered(ran), ...end({ type: "error", message: otherModel(ran, o.model) })]
        lastAssistant = textOf(msg.content)
        lastError = msg.stopReason === "error" || msg.stopReason === "aborted" ? String(msg.errorMessage ?? msg.stopReason) : undefined
        return answered(ran)
      }
      case "agent_settled":
        if (m.aborted) return end({ type: "error", message: "Pi turn cancelled" })
        if (lastError) return end({ type: "error", message: `pi: ${lastError}`.slice(0, 500) })
        return end({ type: "done", text: lastAssistant })
      default:
        return []
    }
  }
}

/**
 * `pi --list-models`: a table whose first two columns are the provider and the model, under a
 * `provider model` header. With none, Pi prints a sentence instead ("No models available. Use /login
 * …"), which isn't a row: only lines after the header count (it was once listed as "No/models").
 */
export function parseModels(text: string): string[] {
  const out: string[] = []
  let table = false
  for (const line of text.split("\n")) {
    const [provider, model] = line.trim().split(/\s+/)
    if (provider === "provider" && model === "model") {
      table = true
      continue
    }
    if (!table || !provider || !model) continue
    if (/^[\w.-]+$/.test(provider) && /^\S+$/.test(model)) out.push(`${provider}/${model}`)
  }
  return [...new Set(out)]
}

/**
 * The models a turn can run: every model Pi lists, less a Claude, ChatGPT or Grok
 * subscription's, with a line naming the harness for each one held back. The default is the user's own
 * Pi default when listed, else the only model listed. With several and no default nothing is picked for
 * them: a catalog (OpenRouter's lists hundreds) has no first choice worth spending their credit on.
 */
export function filterModels(ids: string[], kinds: Record<string, string | undefined>, userDefault?: string): { models: EngineModel[]; hidden: string[]; held: Map<string, string> } {
  const held = new Map<string, string>()
  for (const [provider, kind] of Object.entries(kinds)) {
    const sub = SUBSCRIPTIONS[provider]
    if (sub && (kind === "oauth" || provider === "openai-codex")) held.set(provider, `Your ${sub.plan} sign-in in Pi isn't offered here: subscriptions run through their own harness. Pick ${sub.harness} for it.`)
  }
  const models: EngineModel[] = ids.filter((id) => !held.has(splitModel(id)?.provider ?? "")).map((id) => ({ id, label: id }))
  const def = (userDefault && models.find((m) => m.id === userDefault)) || (models.length === 1 ? models[0] : undefined)
  if (def) def.isDefault = true
  return { models, hidden: [...new Set(held.values())], held }
}

/** The user's own Pi default (`defaultProvider` and `defaultModel` in their settings.json), as provider/model. */
export function userDefault(userDir: string): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(userDir, "settings.json"), "utf8")) as Record<string, unknown>
    return typeof s.defaultProvider === "string" && typeof s.defaultModel === "string" ? `${s.defaultProvider}/${s.defaultModel}` : undefined
  } catch {
    return undefined
  }
}

/** Local servers answering here that the user's models.json doesn't name, as providers for a turn's copy. */
export async function findLocal(servers: readonly LocalServer[], userDir: string): Promise<Providers> {
  const user = userModels(userDir).providers ?? {}
  const port = (u: string) => {
    try {
      return new URL(u).port
    } catch {
      return ""
    }
  }
  const named = (s: LocalServer) => s.id in user || Object.values(user).some((p) => typeof p?.baseUrl === "string" && /\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(p.baseUrl) && port(p.baseUrl) === port(s.baseUrl))
  const found: Providers = {}
  await Promise.all(
    servers.filter((s) => !named(s)).map(async (s) => {
      try {
        const res = await fetch(`${s.baseUrl}/models`, { signal: AbortSignal.timeout(700) })
        const body = (await res.json()) as { data?: { id?: unknown }[] }
        const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id !== "")
        if (res.ok && ids.length) found[s.id] = { name: `${s.name} (running here)`, baseUrl: s.baseUrl, api: "openai-completions", apiKey: s.id, models: ids.map((id) => ({ id, name: id })) }
      } catch {
        // Not running here.
      }
    }),
  )
  return found
}

function judgeVersion(bin: string, out: string, missing: boolean): EngineCheck {
  if (missing) return { ok: false, message: `Pi isn't installed (no "${bin}" found). Install it with npm install -g @earendil-works/pi-coding-agent, add a key with pi then /login, and send your message again.` }
  const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  if (!version) return { ok: false, message: `Couldn't read Pi's version from "${bin} --version".` }
  if (!versionAtLeast(version, MIN_PI)) {
    return { ok: false, version, message: `Update Pi: this is ${version}, and the Candle Harness needs ${MIN_PI} or later, the version its read gate was checked on. Run npm install -g @earendil-works/pi-coding-agent.` }
  }
  return { ok: true, version }
}

/** A turn that ended before Pi could start, with words. */
function failed(message: string): Turn {
  const q = eventQueue()
  q.push({ type: "error", message })
  q.end()
  return { events: q.iterate(), cancel: async () => {} }
}

/** A command's stdout, or "" when it fails or takes over 30 s. */
async function output(cmd: string[], env: Record<string, string>, cwd: string): Promise<string> {
  try {
    const run = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const timer = setTimeout(() => run.kill(), 30_000)
    const out = await new Response(run.stdout).text()
    clearTimeout(timer)
    await run.exited
    return out
  } catch {
    return ""
  }
}

/**
 * Pi behind the engine seam. `homesDir` is the core's (state/homes), where a models read makes its
 * private folder; `agentDir` is the user's own PI_CODING_AGENT_DIR when they set one; `local` the
 * servers looked for (tests name their own).
 */
export function piEngine(bin: string, o: { homesDir: string; agentDir?: string; local?: readonly LocalServer[] }): Engine {
  let defaultModel: string | undefined
  let hidden: string[] = []
  let held = new Map<string, string>()
  let local: Providers = {}
  const userDir = (env: Record<string, string>) => o.agentDir ?? join(env.HOME ?? "/nonexistent", ".pi/agent")
  return {
    id: "pi",
    label: "Pi",
    minVersion: MIN_PI,
    capabilities: () => ({ webSearch: false, webFetch: true, files: "own", shellList: true, deltas: true }),
    signIn: "run pi, then /login, for an API key or OpenRouter; or start Ollama or LM Studio",
    needsModel: true,
    check: async (env) => {
      const r = await readVersion(bin, [], { ...env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" })
      return withSaid(judgeVersion(bin, r.out, r.missing === true), r.said)
    },
    models: async (env) => {
      const user = userDir(env)
      local = await findLocal(o.local ?? LOCAL_SERVERS, user)
      const dir = join(o.homesDir, `models-pi-${randomBytes(6).toString("hex")}`)
      try {
        privateAgentDir({ userDir: user, dir, extra: local })
        const run = piEnv(env, dir)
        const ids = parseModels(await output([bin, "--list-models"], run, dir))
        // Only a provider that can be a subscription is asked about, one after the other.
        const kinds: Record<string, string | undefined> = {}
        for (const provider of new Set(ids.map((id) => splitModel(id)?.provider ?? ""))) {
          if (!SUBSCRIPTIONS[provider]) continue
          kinds[provider] = (tryJson((await output([bin, "auth", "check", "--provider", provider, "--json", "--no-refresh"], run, dir)).trim()) as { authType?: string } | undefined)?.authType
        }
        const r = filterModels(ids, kinds, userDefault(user))
        hidden = r.hidden
        held = r.held
        defaultModel = r.models.find((m) => m.isDefault)?.id
        return r.models
      } finally {
        removeAll(dir)
      }
    },
    defaultModel: () => defaultModel,
    modelNotes: () => hidden,
    start: (turn: EngineTurn, hooks: RunHooks = {}) => {
      const model = turn.model ?? defaultModel
      if (!model) return failed("Pi has no model picked, and no default of yours to run. Pick one with ctrl-g.")
      const ref = splitModel(model)
      if (!ref) return failed(`Pi names models as provider/model, and "${model}" isn't one. Pick one with ctrl-g.`)
      // A held-back subscription is refused in a turn too, for a model typed rather than picked.
      const why = held.get(ref.provider)
      if (why) return failed(why)
      const env = hooks.env ?? turn.env
      const gateFile = join(turn.workDir, "candle-gate.ts")
      const agentDir = join(turn.workDir, "pi")
      try {
        writeFileSync(gateFile, GATE_SOURCE as unknown as string, { mode: 0o600 })
        privateAgentDir({ userDir: userDir(env), dir: agentDir, mcp: turn.mcp, extra: local })
      } catch (error) {
        return failed(`Pi couldn't start: its turn folder couldn't be written (${(error as Error).message}).`)
      }
      return runLines("Pi", piArgs({ bin, gateFile, model, systemPrompt: turn.systemPrompt, ...(turn.tools ? { tools: turn.tools } : {}) }), {
        cwd: turn.researchDir,
        parse: piParser({ model }),
        env: { ...piEnv(env, agentDir), CANDLE_HARNESS_RESEARCH_DIR: turn.researchDir, ...piGateEnv(turn.tools) },
        stdin: turn.prompt,
        ...(hooks.onRaw ? { onRaw: hooks.onRaw } : {}),
      })
    },
    explain: (message) => {
      const m = message ?? "Pi ended without a reply."
      if (/\b401\b|Unauthorized|Incorrect API key|User not found/i.test(m)) return `${m}. Pi's key for that provider was refused: check it with pi then /login, or pick another model with ctrl-g.`
      if (/not found\. Use --list-models/.test(m)) return `${m} Pick another model with ctrl-g.`
      return m
    },
  }
}
