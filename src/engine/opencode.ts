// OpenCode as an engine: one `opencode serve` per turn, driven over its HTTP API.
//
// The server listens on 127.0.0.1 behind a fresh random password (OPENCODE_SERVER_PASSWORD), so no other
// local process or web page can drive it, and it's stopped, with everything it started, when the turn ends.
//
// Isolation, from the user's own OpenCode setup (see isolation() for the folders):
//   - our config arrives in OPENCODE_CONFIG_CONTENT: our MCP server the only one, our gate plugin, the
//     research set of tools less any the agent's settings hide, the shell as the agent's setting (off,
//     a list OpenCode and the gate both hold, or everything), sub-agents and skills off, and no
//     tool that asks (a headless turn waits forever on an ask, such as the `question` tool's);
//   - the config home and OpenCode's working folder are an empty folder of the engine's, and HOME a
//     private one, so the user's global config, AGENTS.md, skills, agents, commands and plugins stay out,
//     and so do the plugins in every `.opencode/` and `opencode.json` above the research folder;
//   - project config, Claude Code's files and external skills (~/.claude, ~/.agents) are switched off;
//   - the user's own providers and model choice are the one part of their config carried over (as Pi's
//     models.json is), so a custom endpoint or local model they set up still runs. Read from their
//     config's `provider`, `model`, `enabled_providers` and `disabled_providers` only, never inspected;
//   - `--pure` isn't passed: it drops our gate too. OpenCode's default plugins stay, since its
//     provider sign-ins are among them;
//   - the sign-in stays the user's own file (their data home), refreshed in place by OpenCode. The
//     turn's session is deleted from their history when the turn ends.
//
// The read hold: `external_directory` checks the path as written, so symlinks read through. Our gate
// plugin (opencode-gate.ts, carried in the binary as text and written to the turn's folder) resolves every
// path a tool names, refuses any outside the research folder and any tool off the research set, and makes
// relative paths the research folder's. The prompt isn't sent until the gate says it loaded.
//
// The model is always explicit, and a turn whose stream answers on another one is stopped: OpenCode
// signed out falls back to its own free models. A Claude, ChatGPT or Grok
// subscription signed in through OpenCode isn't offered; those go through their own harness.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
// OpenCode loads the gate from a file, so the binary carries its source as text. Nothing else in src
// imports it as a module, or the bundler would refuse the text import.
// @ts-expect-error a text import of a module
import GATE_SOURCE from "./opencode-gate.ts" with { type: "text" }
import { withoutBunVars } from "../shared/bun-env"
import { resolveBin, withAbsolutePath } from "../shared/exec-path"
import { versionAtLeast } from "../core/candle-mcp"
import { type Engine, type EngineCheck, type EngineModel, type EngineTurn, type McpServer, readVersion, withSaid } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { modelOnce, sourceOf } from "./events"
import { endGroup, eventQueue, killGroup, type LineParser, type RunHooks, tryJson } from "./spawn"
import { DEFAULT_TOOLS, RESEARCH_NAMES, type ResearchName, shellFor, type ShellSetting, type ToolSettings, toolAllowed } from "./tools"

/** The version the read checks passed on, with the gate plugin and `question` off. */
export const MIN_OPENCODE = "1.19.5"
/** The newest version its holds were checked on; a newer major version is said, never blocked. */
export const CHECKED_OPENCODE = "1.19.5"

/** The research set (the gate's own list must match): file tools, web fetch and the to-do list. Candle's tools are `candle_*`. */
export const OPENCODE_TOOLS = ["read", "write", "edit", "multiedit", "apply_patch", "patch", "list", "glob", "grep", "webfetch", "todowrite", "todoread", "invalid"]

/** OpenCode's tools for each research name; the to-do list and `invalid` are always there. */
const OPENCODE_NAMES: Record<ResearchName, string[]> = {
  read: ["read", "list", "glob", "grep"],
  write: ["write", "edit", "multiedit", "apply_patch", "patch"],
  web_fetch: ["webfetch"],
  web_search: [],
}

/** The research tools a turn offers, after the agent's settings. */
export function opencodeTools(t: ToolSettings = DEFAULT_TOOLS): string[] {
  return OPENCODE_TOOLS.filter((x) => !RESEARCH_NAMES.some((n) => OPENCODE_NAMES[n].includes(x) && !toolAllowed(t, n)))
}

/**
 * OpenCode's bash rule for the agent's shell: off, everything, or each list entry alone and with any
 * arguments, everything else denied. OpenCode holds the list itself, and the gate holds it again by the
 * same rule as Pi's (no ;, &&, |, redirects or $(…)).
 */
export function opencodeBash(shell: ShellSetting): "deny" | "allow" | Record<string, "allow" | "deny"> {
  if (shell === "off") return "deny"
  if (shell === "everything") return "allow"
  return { "*": "deny", ...Object.fromEntries(shell.flatMap((e) => [[e, "allow"], [`${e} *`, "allow"]])) }
}

/** Subscriptions that run through their own harness only, by OpenCode's provider id, with the harness to use. */
const SUBSCRIPTIONS: Record<string, { plan: string; harness: string }> = {
  openai: { plan: "ChatGPT", harness: "Codex" },
  anthropic: { plan: "Claude", harness: "Claude Code" },
  xai: { plan: "SuperGrok", harness: "Grok" },
}

export interface ModelRef {
  providerID: string
  modelID: string
}

/** `provider/model` as OpenCode names it; the model's own id may hold slashes (openrouter/vendor/model). */
export function splitModel(id: string): ModelRef | undefined {
  const at = id.indexOf("/")
  if (at <= 0 || at === id.length - 1) return undefined
  return { providerID: id.slice(0, at), modelID: id.slice(at + 1) }
}

/** The part of the user's own config carried into a turn: their providers and model choice, as written. */
export type UserProviders = Partial<Record<"provider" | "model" | "enabled_providers" | "disabled_providers", unknown>>

/** The user's global OpenCode config's providers, from `<config home>/opencode/{config.json,opencode.json,opencode.jsonc}`, later files winning. */
export function userProviders(configHome: string): UserProviders {
  const out: UserProviders = {}
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const file = join(configHome, "opencode", name)
    if (!existsSync(file)) continue
    try {
      const c = Bun.JSONC.parse(readFileSync(file, "utf8")) as Record<string, unknown>
      for (const key of ["provider", "model", "enabled_providers", "disabled_providers"] as const) if (c?.[key] !== undefined) out[key] = c[key]
    } catch {
      // A config OpenCode itself would refuse: nothing of it carried over.
    }
  }
  return out
}

/** The turn's config: ours, with only the user's providers carried over. */
export function opencodeConfig(o: { mcp: McpServer; gateFile: string; researchDir: string; user?: UserProviders; tools?: ToolSettings }) {
  const research = existsSync(o.researchDir) ? realpathSync(o.researchDir) : o.researchDir
  const shell = shellFor(o.tools ?? DEFAULT_TOOLS, { shellList: true })
  const tools: Record<string, boolean> = { "*": false, "candle_*": true }
  for (const t of opencodeTools(o.tools)) tools[t] = true
  if (shell !== "off") tools.bash = true
  return {
    $schema: "https://opencode.ai/config.json",
    ...o.user,
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    mcp: { candle: { type: "local", command: [o.mcp.command, ...o.mcp.args], environment: o.mcp.env, enabled: true } },
    plugin: [`file://${o.gateFile}`],
    tools,
    // Nothing may ask: headless, nobody answers and the turn hangs. The shell is the agent's setting, and
    // sub-agents would step round the step cap. OpenCode's working folder isn't the research folder (see
    // isolation), so external_directory lets the research folder through and nothing else: the gate's first
    // line, as the paths are written.
    permission: {
      bash: opencodeBash(shell),
      task: "deny",
      skill: "deny",
      edit: "allow",
      webfetch: "allow",
      external_directory: { "*": "deny", [research]: "allow", [`${research}/*`]: "allow" },
      doom_loop: "deny",
      question: "deny",
    },
  }
}

const SIGNED_OUT = (provider: string) => `OpenCode isn't signed in to ${provider}. Run opencode auth login in a terminal, then send your message again, or pick another model with ctrl-g.`
const stoppedAt = (tool: string) => `OpenCode stopped the turn: its ${tool} call needed an approval it can't ask for here. Ask again without it.`
const otherModel = (ran: string, picked: string) =>
  `OpenCode answered on ${ran}, not ${picked}, so the turn stopped before anything it did counted. It does that when it can't reach the model picked: check opencode auth list, or pick another model with ctrl-g.`

/** What the gate reads: the shell setting, and the research tools offered when the agent's settings hide any. */
export function gateEnv(t: ToolSettings = DEFAULT_TOOLS): Record<string, string> {
  const shell = shellFor(t, { shellList: true })
  const offered = opencodeTools(t)
  return {
    ...(shell !== "off" ? { CANDLE_GATE_SHELL: shell === "everything" ? "everything" : JSON.stringify(shell) } : {}),
    ...(offered.length < OPENCODE_TOOLS.length ? { CANDLE_GATE_TOOLS: offered.join(",") } : {}),
  }
}

/** OpenCode names an MCP tool `<server>_<tool>`; ours is the only server, reported as the other engines report it. */
const toolName = (tool: string) => (tool.startsWith("candle_") ? `mcp__candle__${tool.slice("candle_".length)}` : tool)

/**
 * Parses the data of one /event message. `model` is the one picked: an assistant message on any other
 * ends the turn. `onPermission` hears each approval OpenCode asks for, so the engine can refuse it.
 */
export function opencodeParser(o: { sessionID?: string; model?: ModelRef; onPermission?: (id: string) => void } = {}): LineParser {
  const roles = new Map<string, string>() // messageID -> role
  const partTypes = new Map<string, string>() // partID -> part type
  const texts = new Map<string, Map<string, string>>() // messageID -> partID -> final text
  const called = new Set<string>()
  const answered = modelOnce()
  let lastAssistant: string | undefined
  let ended = false // a session.error is followed by session.idle; the turn has already ended
  const end = (e: EngineEvent): EngineEvent[] => {
    ended = true
    return [e]
  }
  return (line) => {
    const e = tryJson(line)
    if (ended || !e || typeof e !== "object" || typeof e.type !== "string") return []
    const p = e.properties ?? {}
    const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID
    if (o.sessionID && sid && sid !== o.sessionID) return []
    switch (e.type) {
      case "message.updated": {
        const info = p.info ?? {}
        if (info.id) roles.set(info.id, info.role)
        if (info.role !== "assistant") return []
        lastAssistant = info.id
        const ran = typeof info.modelID === "string" && typeof info.providerID === "string" ? answered(`${info.providerID}/${info.modelID}`) : []
        if (o.model && typeof info.modelID === "string" && (info.modelID !== o.model.modelID || info.providerID !== o.model.providerID)) {
          return [...ran, ...end({ type: "error", message: otherModel(`${info.providerID}/${info.modelID}`, `${o.model.providerID}/${o.model.modelID}`) })]
        }
        return ran
      }
      case "message.part.updated": {
        const part = p.part ?? {}
        partTypes.set(part.id, part.type)
        if (part.type === "text" && roles.get(part.messageID) === "assistant") {
          const m = texts.get(part.messageID) ?? new Map()
          m.set(part.id, String(part.text ?? ""))
          texts.set(part.messageID, m)
        }
        if (part.type !== "tool") return []
        const status = part.state?.status
        const name = toolName(String(part.tool))
        const out: EngineEvent[] = []
        if ((status === "running" || status === "completed" || status === "error") && !called.has(part.callID)) {
          called.add(part.callID)
          out.push({ type: "tool_call", id: part.callID, name, input: part.state?.input })
        }
        if (status === "completed" || status === "error") {
          const output = status === "completed" ? String(part.state?.output ?? "") : `error: ${String(part.state?.error ?? "")}`
          out.push({ type: "tool_result", id: part.callID, name, output, source: sourceOf(name), ...(status === "error" ? { failed: true as const } : {}) })
        }
        return out
      }
      case "message.part.delta": {
        if (p.field !== "text" || partTypes.get(p.partID) !== "text" || roles.get(p.messageID) !== "assistant") return []
        return [{ type: "text", delta: String(p.delta ?? "") }]
      }
      case "permission.asked":
      case "permission.updated": {
        const id = p.id ?? p.requestID
        if (typeof id === "string") o.onPermission?.(id)
        return end({ type: "error", message: stoppedAt(String(p.permission ?? p.type ?? p.tool?.name ?? "a tool")) })
      }
      case "session.error": {
        const err = p.error ?? {}
        if (err.name === "ProviderAuthError") return end({ type: "error", message: SIGNED_OUT(String(err.data?.providerID ?? "its provider")) })
        if (err.name === "MessageAbortedError") return end({ type: "error", message: "OpenCode turn cancelled" })
        return end({ type: "error", message: `opencode: ${err.data?.message ?? err.name ?? "session error"}`.slice(0, 500) })
      }
      case "session.idle": {
        const parts = lastAssistant ? texts.get(lastAssistant) : undefined
        return end({ type: "done", text: parts ? [...parts.values()].join("\n").trim() : "" })
      }
      default:
        return []
    }
  }
}

/** `opencode models`: one `provider/model` a line. */
export function parseModels(text: string): string[] {
  return [...new Set(text.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)))]
}

/** `opencode auth list`: each stored credential's provider name and kind (`oauth`, `api`, …), never its contents. */
export function parseAuthList(text: string): { name: string; kind: string }[] {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "")
  const out: { name: string; kind: string }[] = []
  for (const line of plain.split("\n")) {
    const m = /^\s*●\s+(.+?)\s+(\S+)\s*$/.exec(line)
    if (m) out.push({ name: m[1]!, kind: m[2]!.toLowerCase() })
  }
  return out
}

/**
 * The models a turn can run: every model OpenCode lists, less a Claude, ChatGPT or Grok
 * subscription's, with a line naming the harness for each one held back. OpenCode's own free models are
 * listed but never the default, so a turn never quietly runs on one.
 */
export function filterModels(ids: string[], auth: { name: string; kind: string }[], userModel?: string): { models: EngineModel[]; hidden: string[]; held: Map<string, string> } {
  const providers = new Set(ids.map((id) => splitModel(id)?.providerID).filter((p): p is string => !!p))
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  const held = new Map<string, string>()
  for (const a of auth) {
    if (a.kind !== "oauth") continue
    const id = [...providers].find((p) => norm(p) === norm(a.name))
    const sub = id ? SUBSCRIPTIONS[id] : undefined
    if (id && sub) held.set(id, `Your ${sub.plan} sign-in in OpenCode isn't offered here: subscriptions run through their own engine. Pick ${sub.harness} for it.`)
  }
  const models: EngineModel[] = ids.filter((id) => !held.has(splitModel(id)?.providerID ?? "")).map((id) => ({ id, label: id }))
  const usable = models.filter((m) => !m.id.startsWith("opencode/"))
  const def = (typeof userModel === "string" && usable.find((m) => m.id === userModel)) || usable[0]
  if (def) def.isDefault = true
  return { models, hidden: [...held.values()], held }
}

function judgeVersion(bin: string, out: string, missing: boolean): EngineCheck {
  if (missing) return { ok: false, message: `OpenCode isn't installed (no "${bin}" found). Install it from opencode.ai, sign in with opencode auth login, and send your message again.` }
  const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  if (!version) return { ok: false, message: `Couldn't read OpenCode's version from "${bin} --version".` }
  if (!versionAtLeast(version, MIN_OPENCODE)) {
    return { ok: false, version, message: `Update OpenCode: this is ${version}, and the Candle Harness needs ${MIN_OPENCODE} or later, the version its read gate was checked on. Run opencode upgrade.` }
  }
  return { ok: true, version }
}

/** A turn that ended before OpenCode could start, with words. */
function failed(message: string): Turn {
  const q = eventQueue()
  q.push({ type: "error", message })
  q.end()
  return { events: q.iterate(), cancel: async () => {} }
}

/**
 * The environment and working folder that keep the user's setup out, in the engine's own folder under the
 * core's state (one for every turn: with an external plugin configured, OpenCode installs its plugin
 * package into the config folder, 3 s and a network call each time the folder is new; no
 * agent can write in the state folder):
 *   - our config, and an empty config home as XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR, so their global
 *     config, AGENTS.md, skills, agents, commands and plugins stay out;
 *   - OpenCode's working folder is that empty config folder. From any other folder it loads every
 *     `.opencode/` and `opencode.json` plugin from there up (the research folder's, its
 *     parent's and the home folder's, git or not, whatever OPENCODE_DISABLE_PROJECT_CONFIG says), and
 *     the research folder is one the agent writes in. From its own config folder it scans nothing;
 *   - a private HOME, since `~/.opencode` is always read; the data, cache and state homes stay the
 *     user's, named explicitly, so the sign-in in the data home is theirs, refreshed in place;
 *   - project config, Claude Code's files and external skills (~/.claude, ~/.agents) off.
 */
export function isolation(env: Record<string, string>, folder: string, config: unknown): { env: Record<string, string>; cwd: string } {
  const home = env.HOME ?? "/nonexistent"
  const configHome = join(folder, "config")
  const cwd = join(configHome, "opencode")
  const privateHome = join(folder, "home")
  for (const d of [cwd, privateHome]) mkdirSync(d, { recursive: true, mode: 0o700 })
  return {
    cwd,
    env: {
      ...env,
      XDG_DATA_HOME: env.XDG_DATA_HOME ?? join(home, ".local/share"),
      XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? join(home, ".cache"),
      XDG_STATE_HOME: env.XDG_STATE_HOME ?? join(home, ".local/state"),
      HOME: privateHome,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_CONFIG_DIR: cwd,
      XDG_CONFIG_HOME: configHome,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
  }
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
 * OpenCode behind the engine seam. `folder` is the engine's own, under the core's state (see isolation).
 * `xdg` is the core's own environment: where the user keeps OpenCode's config (for
 * their providers), and its data and cache when they moved them (the sign-in is in the data home), since
 * a harness's environment is cut down to harnessEnv's.
 */
export function opencodeEngine(bin: string, o: { folder: string; xdg?: Record<string, string | undefined> }): Engine {
  let defaultModel: string | undefined
  let hidden: string[] = []
  let held = new Map<string, string>() // provider id -> why its models aren't offered
  const user = (env: Record<string, string>) => userProviders(o.xdg?.XDG_CONFIG_HOME ?? join(env.HOME ?? "/nonexistent", ".config"))
  const homes: Record<string, string> = {}
  for (const k of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) if (o.xdg?.[k]) homes[k] = o.xdg[k]!
  const withHomes = (env: Record<string, string>) => ({ ...env, ...homes })
  return {
    id: "opencode",
    label: "OpenCode",
    minVersion: MIN_OPENCODE,
    checkedVersion: CHECKED_OPENCODE,
    capabilities: () => ({ webSearch: false, webFetch: true, files: "own", shellList: true, deltas: true }),
    signIn: "opencode auth login, for an API key or OpenRouter",
    needsModel: true,
    check: async (env) => {
      const r = await readVersion(bin, [], withHomes(env))
      return withSaid(judgeVersion(bin, r.out, r.missing === true), r.said)
    },
    models: async (env) => {
      const u = user(env)
      // A folder of its own: a short `opencode models` can leave OpenCode's install lock on its config
      // folder behind, and a turn's server in the same folder would wait the minute it takes to go stale.
      const iso = isolation(withHomes(env), join(o.folder, "models"), { ...u, autoupdate: false, share: "disabled" })
      // One after the other: on a fresh data folder, two at once race to make OpenCode's database.
      const ids = parseModels(await output([bin, "models"], iso.env, iso.cwd))
      const auth = parseAuthList(await output([bin, "auth", "list"], iso.env, iso.cwd))
      const r = filterModels(ids, auth, typeof u.model === "string" ? u.model : undefined)
      hidden = r.hidden
      held = r.held
      defaultModel = r.models.find((m) => m.isDefault)?.id
      return r.models
    },
    defaultModel: () => defaultModel,
    modelNotes: () => hidden,
    start: (turn: EngineTurn, hooks: RunHooks = {}) => {
      const picked = turn.model ?? defaultModel
      const model = picked ? splitModel(picked) : undefined
      if (!model) {
        return failed(
          picked
            ? `OpenCode names models as provider/model, and "${picked}" isn't one. Pick one with ctrl-g.`
            : "OpenCode has no model to run here: none is picked, and it lists none of yours (its own free models are never picked for you). Sign in with opencode auth login, or pick a model with ctrl-g.",
        )
      }
      // A held-back subscription is refused in a turn too, for a model typed rather than picked.
      const why = held.get(model.providerID)
      if (why) return failed(why)
      const env = withHomes(hooks.env ?? turn.env)
      const gateFile = join(turn.workDir, "candle-gate.ts")
      const marker = join(turn.workDir, "gate-loaded")
      let iso
      try {
        writeFileSync(gateFile, GATE_SOURCE as string, { mode: 0o600 })
        iso = isolation(env, join(o.folder, "turns"), opencodeConfig({ mcp: turn.mcp, gateFile, researchDir: turn.researchDir, user: user(env), ...(turn.tools ? { tools: turn.tools } : {}) }))
      } catch (error) {
        return failed(`OpenCode couldn't start: its turn folder couldn't be written (${(error as Error).message}).`)
      }
      const password = randomBytes(24).toString("hex")
      const serverEnv = { ...iso.env, OPENCODE_SERVER_PASSWORD: password, CANDLE_HARNESS_RESEARCH_DIR: turn.researchDir, CANDLE_GATE_MARKER: marker, ...gateEnv(turn.tools) }
      return runServer({ bin, cwd: iso.cwd, env: serverEnv, password, model, prompt: turn.prompt, system: turn.systemPrompt, marker, ...(hooks.onRaw ? { onRaw: hooks.onRaw } : {}) })
    },
    explain: (message) => message ?? "OpenCode ended without a reply.",
  }
}

/**
 * One turn on its own server: start it, wait for the gate, send the prompt, and read the event stream
 * until the session is idle. The last event (done or error) is pushed at once; the stream ends only after
 * the session is deleted and the server, with everything it started, has stopped.
 */
function runServer(o: { bin: string; cwd: string; env: Record<string, string>; password: string; model: ModelRef; prompt: string; system: string; marker: string; onRaw?: (line: string) => void }): Turn {
  const q = eventQueue()
  let finished = false
  let reader: { cancel(): Promise<void> } | undefined
  const finish = (e: EngineEvent) => {
    if (finished) return
    finished = true
    q.push(e)
    void reader?.cancel().catch(() => {})
  }
  let base = ""
  let sessionID = ""
  let stopping = false
  const auth = { Authorization: `Basic ${btoa(`opencode:${o.password}`)}` }
  const api = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, { method, headers: { ...auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) })

  let server: ReturnType<typeof spawn>
  try {
    server = spawn(resolveBin(o.bin, o.env.PATH), ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: o.cwd, env: withoutBunVars(withAbsolutePath(o.env)), detached: true, stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    return failed(`OpenCode couldn't start: ${(error as Error).message}`)
  }
  // The session goes from the user's history, then the server and everything it started (our MCP server too).
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      stopping = true
      if (sessionID && base) await api(`/session/${sessionID}`, "DELETE").catch(() => {})
      if (server.pid !== undefined) await endGroup(server.pid)
    })())

  server.on("error", (err: NodeJS.ErrnoException) => {
    finish({ type: "error", message: err.code === "ENOENT" ? `OpenCode isn't installed (no "${o.bin}" found). Install it from opencode.ai, and send your message again.` : `OpenCode couldn't start: ${err.message}` })
  })
  let stderrTail = ""
  server.stderr!.setEncoding("utf8")
  server.stderr!.on("data", (s: string) => (stderrTail = (stderrTail + s).slice(-2000)))
  const listening = new Promise<string>((resolve, reject) => {
    let buf = ""
    server.stdout!.setEncoding("utf8")
    server.stdout!.on("data", (s: string) => {
      buf = (buf + s).slice(-4000)
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf)
      if (m) resolve(m[1]!)
    })
    server.once("close", (code, signal) => reject(new Error(`its server stopped before it was ready (${signal ?? `exit ${code}`}) ${stderrTail.trim().slice(-300)}`.trim())))
    setTimeout(() => reject(new Error("its server wasn't ready after 30 s")), 30_000).unref()
  })
  // A server that dies mid-turn ends the turn once what it sent has been read: its event stream closes
  // with it, and the words say why.
  let died: string | undefined
  let closed!: () => void
  const serverClosed = new Promise<void>((r) => (closed = r))
  server.on("close", (code, signal) => {
    closed()
    if (stopping) return
    died = `OpenCode's server stopped mid-turn (${signal ?? `exit ${code}`}) ${stderrTail.trim().slice(-300)}`.trim()
    if (!reader) finish({ type: "error", message: died })
  })

  ;(async () => {
    try {
      base = await listening
      const events = await fetch(`${base}/event`, { headers: auth })
      if (!events.ok || !events.body) throw new Error(`its event stream refused: HTTP ${events.status}`)
      const session = await api("/session", "POST", { title: "candle-harness turn" })
      if (!session.ok) throw new Error(`a session refused: HTTP ${session.status} ${(await session.text()).slice(0, 200)}`)
      sessionID = ((await session.json()) as { id: string }).id
      // The gate loads with the session's instance. Without it, reads through links are open: nothing is sent.
      for (let waited = 0; !existsSync(o.marker); waited += 50) {
        if (waited >= 5_000 || finished) {
          finish({ type: "error", message: "OpenCode's read gate didn't load, so the turn stopped before anything was sent. Run candle-harness doctor, or pick another engine with ctrl-g." })
          return
        }
        await Bun.sleep(50)
      }
      const parse = opencodeParser({ sessionID, model: o.model, onPermission: (id) => void api(`/permission/${id}/reply`, "POST", { reply: "reject" }).catch(() => {}) })
      const sent = await api(`/session/${sessionID}/prompt_async`, "POST", { parts: [{ type: "text", text: o.prompt }], model: o.model, system: o.system })
      if (!sent.ok) throw new Error(`the prompt was refused: HTTP ${sent.status} ${(await sent.text()).slice(0, 300)}`)
      const stream = events.body.getReader()
      reader = stream
      const decoder = new TextDecoder()
      let buf = ""
      while (!finished) {
        const { value, done } = await stream.read().catch(() => ({ value: undefined, done: true as const }))
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          o.onRaw?.(data)
          for (const ev of parse(data)) {
            if (ev.type === "done" || ev.type === "error") finish(ev)
            else if (!finished) q.push(ev)
          }
        }
      }
      // The stream can close a moment before the server's exit is seen: wait for it, so the words say why.
      if (!finished) await Promise.race([serverClosed, Bun.sleep(500)])
      if (!finished) finish({ type: "error", message: died ?? "OpenCode's event stream ended before the turn did." })
    } catch (err) {
      if (!stopping) finish({ type: "error", message: died ?? `OpenCode couldn't run the turn: ${(err as Error).message}` })
    } finally {
      await stop()
      q.end()
    }
  })()

  return {
    events: q.iterate(),
    async cancel() {
      if (finished) return
      if (sessionID) await api(`/session/${sessionID}/abort`, "POST", {}).catch(() => {})
      finish({ type: "error", message: "OpenCode turn cancelled" })
      await stop()
      if (server.pid !== undefined) killGroup(server.pid, "SIGKILL")
    },
  }
}
