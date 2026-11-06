// Grok as an engine: `grok --prompt-file … --output-format streaming-messages-json`. Its stream is Claude
// Code's line format, so the parsing mirrors claude.ts, with MCP calls arriving through Grok's `use_tool`.
//
// Isolation, from the user's own Grok setup and everything else of theirs Grok reads:
//   - a private home per turn (home.ts), used as both GROK_HOME and HOME. GROK_HOME keeps the user's
//     ~/.grok out (config, rules, AGENTS.md, skills, memory, hooks, plugins, trusted folders); HOME keeps
//     out the skills Grok reads from ~/.claude, ~/.cursor and ~/.agents whatever its compat settings say
//     (`grok inspect` lists them with every compat cell off);
//   - our own config.toml there: every Claude Code, Cursor and Codex compat cell, memory, workflows and
//     subagents off, and our MCP server the only one named;
//   - a managed_config.toml there holding Grok's own MCP allowlist: only our server's exact command
//     runs, and no project's. Grok loads MCP servers from a .grok/config.toml or .mcp.json in the
//     research folder and each folder above it, the user's own ~/.grok/config.toml too when their home
//     is a git repo, and folder trust doesn't stop them all; the allowlist does, trusted or not;
//   - no folder is trusted in a fresh home, so no project's AGENTS.md, rules, skills, hooks or plugins
//     load.
//
// The read hold: `workspace` reads anything, so ours is a profile on `strict`, which reads only the
// working folder (the research folder), system paths and Grok's home, kernel-enforced on the whole
// process (Landlock here, Seatbelt on macOS). It grants read-only what the shim needs to start (the
// binary's folder, or Bun's and the repo's in development, and the turn's own token folder), and never
// the core's state folder, which holds the keys, the journal and the view token: the shim reaches the
// core's socket without one. A non-empty `deny` (the key folder, among others) makes Grok refuse to
// start rather than run unenforced, and the turn counts only once Grok's own sandbox log says the
// profile was enforced. What the process must read but the model mustn't (Grok's home, which holds the
// copied sign-in, and the shim's grants) is denied to the file tools by Grok's own permission rules
// (read_file printed the sign-in whole without them), with /proc and the shared temporary folders.
// System paths (/etc and the like) stay readable to the file tools: `strict` needs them for the process.
//
// What it can reach: its file tools in the research folder, web search and fetch, and Candle's tools,
// less any the agent's settings hide. Subagents are off. The shell is the agent's setting:
// a list is held by Grok's own rules (grokShellRules), and
// "everything" runs under bypassPermissions. Either way it runs under the same kernel profile: it reads
// only what the process may, so never the core's key folder, but its tool denies don't hold it, so it
// can read Grok's home. `/tmp` and `/var/tmp` stay readable and writable to the process under every
// Grok profile, so to the shell too; the file tools are denied them.
//
// What's on the command line is no secret: the prompt (the transcript, the user's message and the agent's
// memory) goes in a 0600 file in the private home, and the harness token is in a 0600 file the shim reads.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { versionAtLeast } from "../core/candle-mcp"
import { paths } from "../paths"
import { type Engine, type EngineCheck, type EngineModel, type EngineTurn, type McpServer, readVersion, withSaid } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { modelOnce, sourceOf } from "./events"
import { privateHome, removeAll } from "./home"
import { eventQueue, type LineParser, type RunHooks, runLines, tryJson } from "./spawn"
import { DEFAULT_TOOLS, RESEARCH_NAMES, type ResearchName, shellFor, type ToolSettings, toolAllowed } from "./tools"

/** The version the read checks passed on: the `strict` profile, and a custom profile's fail-closed `deny`. */
export const MIN_GROK = "1.0.70"

/** Our sandbox profile's name in the private home's sandbox.toml. */
export const GROK_PROFILE = "candle"

/** The research set: Grok's other tools (image and video generation, plan mode, goals, asking the user, and send_feedback, which sends content to xAI) stay out. */
export const GROK_TOOLS = ["read_file", "list_dir", "grep", "write", "search_replace", "todo_write", "web_search", "web_fetch"]

/** Grok's tools for each research name. */
const GROK_NAMES: Record<ResearchName, string[]> = { read: ["read_file", "list_dir", "grep"], write: ["write", "search_replace"], web_search: ["web_search"], web_fetch: ["web_fetch"] }

const toml = (s: string) => JSON.stringify(s) // a JSON string is a valid TOML basic string

/** The private home's config.toml: none of the user's setup, by any compat route, and our MCP server only. */
export function grokConfig(mcp: McpServer): string {
  const cells = (keys: string[]) => keys.map((k) => `${k} = false`)
  const env = Object.entries(mcp.env)
  return [
    "[cli]", "auto_update = false",
    "[compat.claude]", ...cells(["skills", "rules", "agents", "mcps", "hooks"]),
    "[compat.cursor]", ...cells(["skills", "rules", "agents", "mcps", "hooks"]),
    "[compat.codex]", ...cells(["skills", "hooks"]),
    "[memory]", "enabled = false",
    "[memory_v2]", "enabled = false",
    "[workflows]", "enabled = false",
    "[subagents]", "enabled = false",
    "[features]", "telemetry = false", "feedback = false",
    "[mcp_servers.candle]", `command = ${toml(mcp.command)}`, `args = [${mcp.args.map(toml).join(", ")}]`,
    ...(env.length ? [`env = { ${env.map(([k, v]) => `${toml(k)} = ${toml(v)}`).join(", ")} }`] : []),
    "",
  ].join("\n")
}

/** The private home's managed_config.toml: Grok's own MCP allowlist, our server's exact command and nothing else, project servers dropped. */
export function grokManaged(mcp: McpServer): string {
  return [
    "allow_managed_mcp_servers_only = true",
    "enable_all_project_mcp_servers = false",
    "allow_managed_hooks_only = true",
    "[[allowed_mcp_servers]]",
    `server_command = [${[mcp.command, ...mcp.args].map(toml).join(", ")}]`,
    "",
  ].join("\n")
}

/**
 * What the shim needs to read to start, as folders (Grok grants folders only): the binary's own, the
 * turn's token folder, and, for a script Bun runs in development, the package it sits in (Bun reads its
 * package.json and tsconfig.json to resolve modules). Never the core's state folder.
 */
export function grokReads(mcp: McpServer): string[] {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : undefined)
  const reads = new Set<string>()
  const bin = mcp.command.startsWith("/") ? real(mcp.command) : undefined
  if (bin) reads.add(dirname(bin))
  const t = mcp.args.indexOf("--token-file")
  const token = t >= 0 ? mcp.args[t + 1] : undefined
  if (token && real(dirname(token))) reads.add(real(dirname(token))!)
  for (const arg of mcp.args) {
    if (arg === token || !arg.startsWith("/")) continue
    const file = real(arg)
    if (!file || !statSync(file).isFile()) continue
    let dir = dirname(file)
    while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir)
    reads.add(existsSync(join(dir, "package.json")) ? dir : dirname(file))
  }
  return [...reads]
}

/**
 * The private home's sandbox.toml: `strict`, plus read-only grants and a non-empty deny list. Child
 * network stays on: `restrict_network` also refuses the shim's connect to the core's socket, and
 * the shim is the only child Grok starts while the shell is off. Every deny path must exist: Grok makes
 * an empty file at one that doesn't.
 */
export function grokSandbox(o: { reads: string[]; deny: string[] }): string {
  return [
    `[profiles.${GROK_PROFILE}]`,
    'extends = "strict"',
    "restrict_network = false",
    `read_only = [${o.reads.map(toml).join(", ")}]`,
    "read_write = []",
    `deny = [${o.deny.map(toml).join(", ")}]`,
    "",
  ].join("\n")
}

export interface GrokTurn {
  /** The `grok` binary: a name on PATH, or a path (config `engine.grok.path`). */
  bin: string
  /** The 0600 file holding the prompt. */
  promptFile: string
  /** The Candle trader prompt, appended to Grok's own as rules. */
  systemPrompt: string
  researchDir: string
  /** Folders the kernel lets Grok read that its file tools must not: its own home, the shim's grants, /proc. */
  denyReads?: string[]
  model?: string
  /** The agent's shell and tool settings. */
  tools?: ToolSettings
}

/**
 * Tool-level denies for what `strict` lets the process read but the model mustn't: Grok's own home
 * holds the copied sign-in, which read_file printed whole; the shim's grants hold its token and, in
 * development, the repo; /proc holds the process's environment; the temporary folders hold other tools' files. Each folder is denied itself (list_dir,
 * grep) and below (read_file); Read rules govern grep too, and Edit covers writes.
 */
export function grokDenies(folders: readonly string[]): string[] {
  return folders.flatMap((f) => [`Read(${f})`, `Read(${f}/**)`, `Edit(${f})`, `Edit(${f}/**)`]).flatMap((rule) => ["--deny", rule])
}

/** Grok's "dangerous" commands, which it refuses under any rule given on its command line (Grok 1.0.70): a list can't hold them. */
export const GROK_UNLISTABLE = ["rm", "chmod", "chown", "chgrp", "chattr", "pkill", "kill", "killall", "git push"]

/**
 * A shell list as Grok's allow rules (Grok 1.0.70). Under dontAsk Grok refuses a command unless
 * every segment of it (split on &&, ||, ;, | and newlines) matches an allow rule, and refuses
 * substitutions, subshells and backgrounding outright. A rule's text matches as a prefix with no word
 * boundary (`Bash(ls)` would let `lsof` through) or as a glob of the whole command, so each entry is two
 * rules that only a glob can match: `[l]s` for the command alone (no command starts with `[`) and
 * `ls *` for it with arguments. Entries are plain words (shellEntryFault), with no glob characters.
 * Grok also always runs its own read-only commands (ls, cat, grep…), mkdir and touch, list or not.
 */
export function grokShellRules(list: readonly string[]): string[] {
  return list.flatMap((e) => [`Bash([${e[0]}]${e.slice(1)})`, `Bash(${e} *)`]).flatMap((rule) => ["--allow", rule])
}

export function grokArgs(o: GrokTurn): string[] {
  const r = o.researchDir
  const t = o.tools ?? DEFAULT_TOOLS
  const on = (n: ResearchName) => toolAllowed(t, n)
  const setting = shellFor(t, { shellList: true })
  const shell = setting !== "off"
  const tools = GROK_TOOLS.filter((g) => !RESEARCH_NAMES.some((n) => GROK_NAMES[n].includes(g) && !on(n)))
  return [
    o.bin,
    // The prompt is read from a file, sent as written: a transcript is data, never `@file` references.
    "--prompt-file", o.promptFile, "--verbatim",
    "--rules", o.systemPrompt,
    "--output-format", "streaming-messages-json", "--include-partial-messages",
    "--cwd", r, "--sandbox", GROK_PROFILE, "--no-auto-update",
    // Headless, dontAsk refuses whatever isn't allowed. Grok ignores a catch-all allow rule (`Bash`,
    // `Bash(*)`), and refuses its "dangerous" commands (rm, chmod, kill, git push…) under any rule given
    // here (Grok 1.0.70), so the shell's "everything" is bypassPermissions instead, under which the
    // deny rules below still win (checked: read_file on a denied folder was refused). The kernel profile
    // holds what the process may write either way.
    "--permission-mode", setting === "everything" ? "bypassPermissions" : "dontAsk", "--no-subagents",
    "--tools", [...tools, ...(shell ? ["run_terminal_cmd"] : [])].join(","),
    // Headless Grok refuses an MCP call or a write it hasn't been told it may make.
    "--allow", "MCPTool(candle__*)",
    ...(on("write") ? ["--allow", `Write(${r}/**)`, "--allow", `Edit(${r}/**)`] : []),
    ...(on("read") ? ["--allow", "Read"] : []),
    ...(on("web_fetch") ? ["--allow", "WebFetch"] : []),
    ...(Array.isArray(setting) ? grokShellRules(setting) : []),
    // A deny wins over every allow.
    ...grokDenies(o.denyReads ?? []),
    "--disallowed-tools", shell ? "Agent" : "Agent,run_terminal_cmd",
    ...(o.model ? ["-m", o.model] : []),
  ]
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : JSON.stringify(c))).join("\n")
  return JSON.stringify(content ?? "")
}

// Grok reaches MCP tools through meta-tools: `use_tool` (or `CallMcpTool` on its daemon route) with the
// real `server__tool` name in its input, and `search_tool` to list what's available.
const MCP_CALLERS = new Set(["use_tool", "CallMcpTool"])

/** The tool that really ran, and where its result counts as coming from. */
function resolve(name: string, input: any): { name: string; source: ReturnType<typeof sourceOf> } {
  if (MCP_CALLERS.has(name) && typeof input?.tool_name === "string") {
    const real = input.tool_name.includes("__") ? `mcp__${input.tool_name}` : `mcp__${input.server_name ?? "unknown"}__${input.tool_name}`
    return { name: real, source: sourceOf(real) }
  }
  if (name === "search_tool" || name === "GetMcpTools") return { name, source: "file" } // a list of tools, not data
  return { name, source: sourceOf(name) }
}

const SIGNED_OUT = "Grok isn't signed in. Run grok login in a terminal (grok login --device-code over SSH), then send your message again."
const isSignedOut = (message: string) => /Not signed in|not logged in|\b401\b|Unauthorized/i.test(message)

/**
 * Grok ends a whole turn as "cancelled" when a tool call needs an approval a headless run can't give: a
 * write outside the research folder, or, with deny rules in place, a link it can't resolve (such as a link
 * in the research folder to the denied key folder). The turn says that, rather than that someone
 * cancelled it.
 */
const stoppedAt = (tool: string, asked?: string, command?: string) =>
  // A shell command off the agent's list: Grok ends the turn there, where the
  // other engines hand the refusal back to the model.
  sourceOf(tool) === "shell"
    ? `Grok stopped the turn: its shell command${command ? ` \`${command.slice(0, 120)}\`` : ""} isn't one this agent's list lets it run, and Grok ends a turn at a command it can't run rather than carrying on. Ask again without it.`
    : GROK_FILE_TOOLS.includes(tool)
    ? `Grok stopped the turn: its ${tool} call needed an approval it can't ask for here, for a file outside the research folder or a link that leads out of it. Ask again without that file.`
    : // A tool it isn't given. Asked to run a command with the shell off, Grok calls use_tool for a
      // "shell" rather than saying it has none, and the turn ends there.
      asked && sourceOf(asked) === "shell"
      ? "Grok stopped the turn: it looked for a shell, and the shell is off for this agent. Ask again without a command, or turn the shell on in config (agents.<name>.tools.shell)."
      : `Grok stopped the turn: its ${tool} call needed an approval it can't ask for here, for a tool it isn't given. Ask again.`

/** Grok's tools that name a file, whose unapproved call means a path outside the research folder. */
const GROK_FILE_TOOLS = ["read_file", "list_dir", "grep", "write", "search_replace"]

export function grokParser(): LineParser {
  const calls = new Map<string, ReturnType<typeof resolve>>()
  let unapproved: string | undefined
  // The tool each use_tool call asked for, by call id, and the one the unapproved call asked for.
  const asked = new Map<string, string>()
  let askedFor: string | undefined
  // The command each shell call ran, by call id, and the one refused.
  const commands = new Map<string, string>()
  let refusedCommand: string | undefined
  // Each message names the model that wrote it, as Claude Code's do; signed out, Grok names "unknown".
  const answered = modelOnce(["unknown"])
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
        if (c?.type === "tool_use" || c?.type === "server_tool_use") {
          const r = resolve(String(c.name), c.input)
          calls.set(c.id, r)
          if (MCP_CALLERS.has(c.name) && typeof c.input?.tool_name === "string") asked.set(c.id, c.input.tool_name)
          if (typeof c.input?.command === "string") commands.set(c.id, c.input.command)
          const input = MCP_CALLERS.has(c.name) ? (c.input?.tool_input ?? c.input) : c.input
          out.push({ type: "tool_call", id: c.id, name: r.name, input })
        } else if (c?.type === "web_search_tool_result") {
          // Grok's backend web search arrives inline, right after its server_tool_use block.
          out.push({ type: "tool_result", id: c.tool_use_id, name: "web_search", output: toolResultText(c.content), source: "web" })
        }
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) {
        if (c?.type !== "tool_result") continue
        const r = calls.get(c.tool_use_id) ?? { name: "unknown", source: "file" as const }
        const output = toolResultText(c.content)
        const cancelled = /User cancelled the execution for tool `([^`]+)`/.exec(output)?.[1]
        if (cancelled) {
          unapproved = cancelled
          askedFor = asked.get(c.tool_use_id)
          refusedCommand = commands.get(c.tool_use_id)
        }
        out.push({ type: "tool_result", id: c.tool_use_id, name: r.name, output, source: r.source, ...(c.is_error === true || cancelled ? { failed: true as const } : {}) })
      }
    } else if (m.type === "result") {
      if (m.subtype === "success" && !m.is_error) out.push({ type: "done", text: String(m.result ?? "") })
      else {
        const why = Array.isArray(m.errors) && m.errors.length ? m.errors.map(String).join("; ") : String(m.result ?? m.subtype ?? "error")
        if (isSignedOut(why)) out.push({ type: "error", message: SIGNED_OUT })
        else if (unapproved && (m.stop_reason === "cancelled" || why === "cancelled")) out.push({ type: "error", message: stoppedAt(unapproved, askedFor, refusedCommand) })
        else out.push({ type: "error", message: `grok: ${why}`.slice(0, 500) })
      }
    }
    return out
  }
}

const NOT_ENFORCED = "Grok's sandbox wasn't confirmed on this machine, so the turn stopped before anything it did counted. Pick another engine with ctrl-g, and run candle-harness doctor."

/**
 * Whether Grok's own sandbox log, in the turn's private home, says our profile was enforced on the
 * research folder: undefined when it does, the words to end the turn with when it doesn't.
 */
export function sandboxEnforced(home: string, researchDir: string): string | undefined {
  let lines: string[]
  try {
    lines = readFileSync(join(home, "sessions", "sandbox-events.jsonl"), "utf8").split("\n")
  } catch {
    return NOT_ENFORCED
  }
  const want = existsSync(researchDir) ? realpathSync(researchDir) : researchDir
  const applied = lines.map(tryJson).filter((e) => e?.event_type === "ProfileApplied" && e.profile === GROK_PROFILE)
  const last = applied.at(-1)
  if (!last || last.enforced !== true) return NOT_ENFORCED
  const at = typeof last.workspace === "string" && existsSync(last.workspace) ? realpathSync(last.workspace) : last.workspace
  return at === want ? undefined : NOT_ENFORCED
}

/**
 * The parser behind a gate: nothing Grok says counts until its sandbox log confirms the profile. The
 * sandbox is applied as Grok starts, before its first line, so the log is read once, at that line.
 */
export function enforcedParser(parse: LineParser, verify: () => string | undefined): LineParser {
  let verified = false
  return (line) => {
    if (!verified) {
      if (tryJson(line) === undefined) return []
      const why = verify()
      if (why) return [{ type: "error", message: why }]
      verified = true
    }
    return parse(line)
  }
}

/** `grok models`: the default it names, then each listed model, in its order. */
export function grokModels(text: string): EngineModel[] {
  const named = /Default model:\s*(\S+)/.exec(text)?.[1]
  const out: EngineModel[] = []
  for (const line of text.split("\n")) {
    const m = /^\s*[*-]\s+(\S+)(\s+\(default\))?\s*$/.exec(line)
    if (!m || out.some((e) => e.id === m[1])) continue
    out.push({ id: m[1]!, label: m[1]!, ...(m[2] || m[1] === named ? { isDefault: true } : {}) })
  }
  return out
}

function judgeVersion(bin: string, out: string, missing: boolean): EngineCheck {
  if (missing) return { ok: false, message: `Grok isn't installed (no "${bin}" found). Install it from x.ai/cli, sign in with grok login, and send your message again.` }
  const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  if (!version) return { ok: false, message: `Couldn't read Grok's version from "${bin} --version".` }
  if (!versionAtLeast(version, MIN_GROK)) {
    return { ok: false, version, message: `Update Grok: this is ${version}, and the Candle Harness needs ${MIN_GROK} or later, the version its sandbox and read hold were checked on. Run grok update.` }
  }
  return { ok: true, version }
}

/** A turn that ended before Grok could start, with words. */
function failed(message: string): Turn {
  const q = eventQueue()
  q.push({ type: "error", message })
  q.end()
  return { events: q.iterate(), cancel: async () => {} }
}

/** The shared temporary folders `strict` leaves readable to the whole process: other tools' files (a Kerberos ticket, a socket's secret) sit there. */
const TEMP_FOLDERS = ["/tmp", "/var/tmp", "/dev/shm"]

/**
 * The temporary folders to deny the file tools, each as given and resolved (macOS's /tmp is /private/tmp),
 * with the user's own TMPDIR. A deny wins over every allow, so a folder holding the research folder is
 * left out: denying it would deny the research folder too.
 */
export function tempDenies(researchDir: string, tmpdir: string | undefined): string[] {
  const real = (d: string) => (existsSync(d) ? realpathSync(d) : d)
  const research = real(researchDir)
  const holds = (d: string) => research === d || research.startsWith(`${d.replace(/\/+$/, "")}/`)
  const folders = [...TEMP_FOLDERS, ...(tmpdir ? [tmpdir.replace(/\/+$/, "") || "/"] : [])].flatMap((d) => [d, real(d)])
  return [...new Set(folders)].filter((d) => d !== "/" && !holds(d) && !holds(real(d)))
}

/** The core's files a turn must never read, as deny entries (only those that exist: Grok makes a file at one that doesn't). */
function denied(configDir: string | undefined): string[] {
  if (!configDir) return []
  const p = paths({ CANDLE_HARNESS_HOME: configDir })
  return [p.keysDir, p.viewToken, p.tokens, p.journal].filter((f) => existsSync(f))
}

/**
 * Grok behind the engine seam. `homesDir` is the core's (state/homes), where every private home lives
 * and a dead core's are recovered from; `grokHome` is the user's own GROK_HOME when they set one.
 */
export function grokEngine(bin: string, o: { homesDir: string; grokHome?: string }): Engine {
  let defaultModel: string | undefined
  const realAuth = (env: Record<string, string>) => join(o.grokHome ?? join(env.HOME ?? "", ".grok"), "auth.json")
  const scratch = (what: string) => `${what}-grok-${randomBytes(6).toString("hex")}`
  return {
    id: "grok",
    label: "Grok",
    minVersion: MIN_GROK,
    capabilities: () => ({ webSearch: true, webFetch: true, files: "own", shellList: true, deltas: true }),
    // Whether its sign-in file is there; the Candle Harness never reads it.
    signedIn: async (env) => existsSync(realAuth(env)),
    signIn: "grok login, or grok login --device-code over SSH",
    check: async (env) => {
      // An empty private home: Grok writes its docs and state into whatever home it's given.
      const home = join(o.homesDir, scratch("check"))
      mkdirSync(home, { recursive: true, mode: 0o700 })
      try {
        const r = await readVersion(bin, [], { ...env, HOME: home, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1" })
        return withSaid(judgeVersion(bin, r.out, r.missing === true), r.said)
      } finally {
        removeAll(home)
      }
    },
    models: async (env) => {
      const home = privateHome({ base: o.homesDir, name: scratch("models"), realAuth: realAuth(env), copy: true })
      try {
        const run = Bun.spawn([bin, "models"], { env: { ...env, HOME: home.home, GROK_HOME: home.home, GROK_DISABLE_AUTOUPDATER: "1" }, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
        const timer = setTimeout(() => run.kill(), 30_000)
        const out = await new Response(run.stdout).text()
        clearTimeout(timer)
        await run.exited
        const models = grokModels(out)
        const def = models.find((m) => m.isDefault)
        if (def) defaultModel = def.id
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
        home = privateHome({ base: dirname(turn.workDir), name: `${basename(turn.workDir)}-grok`, realAuth: realAuth(env), copy: true })
      } catch (error) {
        return failed(`Grok couldn't start: its private home couldn't be made (${(error as Error).message}).`)
      }
      const promptFile = join(home.home, "prompt.md")
      const reads = grokReads(turn.mcp)
      // A grant holding the research folder or the Candle Harness's own would open it all to the process: refused.
      const holds = [turn.researchDir, turn.mcp.env.CANDLE_HARNESS_HOME].filter((d): d is string => !!d).map((d) => (existsSync(d) ? realpathSync(d) : d))
      const tooWide = reads.find((g) => holds.some((d) => d === g || d.startsWith(`${g}/`)))
      if (tooWide) {
        home.close()
        return failed(`Grok can't run with the Candle Harness's binary in ${tooWide}: its sandbox would have to open that whole folder. Move candle-harness into a folder of its own, such as ~/.local/bin, or pick another engine with ctrl-g.`)
      }
      try {
        writeFileSync(join(home.home, "config.toml"), grokConfig(turn.mcp), { mode: 0o600 })
        writeFileSync(join(home.home, "managed_config.toml"), grokManaged(turn.mcp), { mode: 0o600 })
        // An empty folder of the home's own keeps the deny list non-empty whatever the core holds yet.
        const sentinel = join(home.home, "deny-sentinel")
        mkdirSync(sentinel, { mode: 0o700 })
        writeFileSync(join(home.home, "sandbox.toml"), grokSandbox({ reads, deny: [...denied(turn.mcp.env.CANDLE_HARNESS_HOME), sentinel] }), { mode: 0o600 })
        writeFileSync(promptFile, turn.prompt, { mode: 0o600 })
      } catch (error) {
        home.close()
        return failed(`Grok couldn't start: its private home couldn't be written (${(error as Error).message}).`)
      }
      // Each as given and as resolved, since a rule matches the path a tool names (macOS's /var is /private/var).
      // The shared temporary folders too, which `strict` leaves readable: the model's file tools stay in the research folder.
      const denyReads = [...new Set([...[home.home, ...reads, "/proc"].flatMap((d) => [d, existsSync(d) ? realpathSync(d) : d]), ...tempDenies(turn.researchDir, env.TMPDIR ?? process.env.TMPDIR)])]
      return runLines("Grok", grokArgs({ bin, promptFile, systemPrompt: turn.systemPrompt, researchDir: turn.researchDir, denyReads, ...(turn.model ? { model: turn.model } : {}), ...(turn.tools ? { tools: turn.tools } : {}) }), {
        cwd: turn.researchDir,
        parse: enforcedParser(grokParser(), () => sandboxEnforced(home.home, turn.researchDir)),
        endOnError: true,
        env: { ...env, HOME: home.home, GROK_HOME: home.home, GROK_MEMORY: "0", GROK_WORKFLOWS: "0" },
        ...(hooks.onRaw ? { onRaw: hooks.onRaw } : {}),
        onExit: () => {
          rmSync(promptFile, { force: true })
          home.close()
        },
      })
    },
    explain: (message) => {
      const m = message ?? "Grok ended without a reply."
      if (m !== SIGNED_OUT && isSignedOut(m)) return `${SIGNED_OUT} (${m})`
      return m
    },
  }
}
