// Pi's read gate. Pi has no sandbox: its own docs say the
// working folder "does not prevent commands from accessing other paths". So the hold is ours, a Pi
// extension loaded with `-e` that does three things:
//   - every read, write, edit and ls is resolved as Pi itself resolves it (a leading @, ~, a file://
//     URL, Unicode spaces), then through links, and refused unless it lands inside the research folder.
//     What goes on to the tool is the exact real path checked, so Pi opens nothing the gate didn't see;
//   - a read of a file that doesn't exist is refused, since Pi's read then tries look-alike names (an
//     NFD form, a curly apostrophe, a macOS screenshot's space) that the gate never saw;
//   - every other tool is refused (fail closed), apart from Candle's (mcp__candle__*) and web_fetch,
//     which this extension adds: a public page's text, with no file or local address;
//   - the shell: `bash` is refused unless CANDLE_GATE_SHELL turns it on, as
//     "everything" or a JSON list of commands; with a list, only a single plain command whose words
//     start with an entry's runs (shellAllows, the same rule as tools.ts's). CANDLE_GATE_TOOLS, when
//     set, narrows the research tools to those it names (the agent's allow and deny lists).
//
// Pi refuses to start when an `-e` extension is missing or throws as it loads (checked on Pi 1.4.0), and
// this one throws without its research folder, so a gate that didn't load means no turn.
//
// The binary carries this file as text and writes it into the turn's folder, and Pi loads it from there
// (its default export), so it uses node's built-ins only. Nothing else in src may import it as a module.
import { lookup } from "node:dns/promises"
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Pi's file tools a turn has; anything else that names a path isn't declared. */
export const FILE_TOOLS = ["read", "write", "edit", "ls"]
export const WEB_FETCH = "web_fetch"
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** The path Pi's file tools open for `raw`, by Pi's own rules (its utils/paths.js, 1.4.0). Throws on a file URL it can't read. */
// --- the shell ---

/** Characters that join, redirect or substitute commands: a listed command must have none (tools.ts). */
const SHELL_OPERATORS = /[;&|<>`$(){}\n\r\\]/

/** Whether `command` may run: everything, or a single plain command whose words start with a listed entry's. Kept the same as tools.ts's by tools.test.ts. */
export function shellAllows(s: "off" | "everything" | readonly string[], command: string): boolean {
  if (s === "everything") return true
  if (s === "off" || typeof command !== "string") return false
  if (SHELL_OPERATORS.test(command)) return false
  const words = command.trim().split(/[ \t]+/)
  if (words[0] === "") return false
  return s.some((entry) => {
    const want = entry.split(" ")
    return want.length <= words.length && want.every((w, i) => words[i] === w)
  })
}

/** CANDLE_GATE_SHELL: unset or "off", "everything", or a JSON list of commands; anything else is off. */
export function gateShell(raw: string | undefined): "off" | "everything" | string[] {
  if (raw === "everything") return "everything"
  try {
    const list = JSON.parse(raw ?? "")
    if (Array.isArray(list) && list.length && list.every((e) => typeof e === "string")) return list
  } catch {
    // Off.
  }
  return "off"
}

export function piPath(raw: string, cwd: string, home: string): string {
  let p = raw.replace(UNICODE_SPACES, " ")
  if (p.startsWith("@")) p = p.slice(1)
  if (p === "~") p = home
  else if (p.startsWith("~/")) p = join(home, p.slice(2))
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p)
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

/** How many links a path may go through, as the kernel allows, before it's refused. */
const MAX_LINKS = 40

/**
 * The real path, or the nearest existing parent's real path plus the rest (a new file). A link that
 * resolves to nothing (its target missing) is followed to what it names, since a write through it lands
 * there, not beside the link.
 */
function realish(p: string, links = 0): string {
  const rest: string[] = []
  for (let cur = p; ; ) {
    try {
      return join(realpathSync(cur), ...rest.reverse())
    } catch {
      let target: string | undefined
      try {
        if (lstatSync(cur).isSymbolicLink()) target = readlinkSync(cur)
      } catch {
        // Not there at all: a new file or folder.
      }
      if (target !== undefined) {
        if (links >= MAX_LINKS) throw new Error(`${p} goes through too many links`)
        return realish(join(resolve(dirname(cur), target), ...rest.reverse()), links + 1)
      }
      const up = dirname(cur)
      if (up === cur) return p
      rest.push(cur.slice(up === "/" ? 1 : up.length + 1))
      cur = up
    }
  }
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

/** Whether `tool` may open `raw` from `research` (a real path), and the exact path it opens if so. */
export function checkPath(tool: string, raw: unknown, research: string, home: string): PathCheck {
  if (raw === undefined && tool === "ls") raw = "."
  if (typeof raw !== "string" || raw === "") return { ok: false, reason: `${tool} needs a path inside your research folder` }
  let real: string
  try {
    real = realish(piPath(raw, research, home))
  } catch {
    return { ok: false, reason: `${raw} isn't a path the gate can check` }
  }
  const rel = relative(research, real)
  if (rel !== "" && (rel === ".." || rel.startsWith("../") || isAbsolute(rel))) return { ok: false, reason: `${raw} is outside your research folder` }
  // What goes on must be a path Pi opens as written: no character it would rewrite on the way.
  if (piPath(real, research, home) !== real) return { ok: false, reason: `${raw} names a file the gate can't hold to your research folder` }
  if (tool === "read" && !existsSync(real)) return { ok: false, reason: `${raw} doesn't exist in your research folder` }
  return { ok: true, path: real }
}

// --- web_fetch ---

const FETCH_TIMEOUT_MS = 20_000
const MAX_BYTES = 2_000_000
export const MAX_CHARS = 50_000
const LOCAL_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i

/** An IPv6 address's eight 16-bit groups, a trailing dotted IPv4 part and any zone (`%eth0`) read too. */
function groups6(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/%.*$/, "")
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail, more] = s.split("::")
  if (more !== undefined) return undefined
  const part = (p: string | undefined) => (p ? p.split(":").map((g) => parseInt(g, 16)) : [])
  const h = part(head)
  const t = part(tail)
  const out = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill(0), ...t]
  return out.length === 8 && out.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? out : undefined
}

/**
 * A loopback, private, link-local, shared or multicast address: none is a public page. An IPv6 address
 * that carries an IPv4 one (mapped, `::ffff:7f00:1` as a URL writes `[::ffff:127.0.0.1]`; compatible;
 * NAT64; 6to4) is judged by the IPv4 address it reaches, since that's where a connection to it goes.
 */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number]
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (v === 6) {
    const g = groups6(ip)
    if (!g) return true
    const v4 = (hi: number, lo: number) => privateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
    const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
    // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (SIIT) never reach a public page as themselves.
    if (zero(0, 6)) return true
    if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!)
    if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return true
    // NAT64's well-known prefix reaches the IPv4 address in its last 32 bits; its local-use prefix is a network's own.
    if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!)
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true
    // 6to4 reaches the IPv4 address in bits 16 to 48.
    if (g[0] === 0x2002) return v4(g[1]!, g[2]!)
    const first = g[0]!
    // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00
  }
  return true
}

const proxied = (env: Record<string, string | undefined>) => Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)

/** A URL checked: why it isn't a public page, or the address the fetch must connect to (none only when the name couldn't be looked up here and a proxy will). */
export type Checked = { why: string } | { address?: string }

/** Looks a name up to every address it has; tests replace it. */
export type Resolve = (host: string) => Promise<{ address: string }[]>

/**
 * Checks `url` once: http(s) only, no local name, and every address its name has public. The fetch then
 * connects to the address checked here, so a name that answers a second lookup with a local address
 * (DNS rebinding) never reaches it. That holds with proxy variables set too: Pi runs this on Node,
 * whose fetch ignores them unless NODE_USE_ENV_PROXY is set, so handing the name to fetch would look
 * it up again. Only a name that can't be looked up here, with a proxy variable set, goes to fetch, for
 * the proxy to look up.
 */
export async function checkUrl(url: URL, env: Record<string, string | undefined> = process.env, resolve: Resolve = (host) => lookup(host, { all: true })): Promise<Checked> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return { why: `web_fetch reads http and https pages only, not ${url.protocol}` }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (LOCAL_NAMES.test(host)) return { why: `web_fetch reads public pages only, not ${host}` }
  if (isIP(host)) return privateAddress(host) ? { why: `web_fetch reads public pages only, not ${host}` } : { address: host }
  let addresses: { address: string }[]
  try {
    addresses = await resolve(host)
  } catch (error) {
    return proxied(env) ? {} : { why: `${host} couldn't be found (${(error as Error).message})` }
  }
  if (!addresses.length) return proxied(env) ? {} : { why: `${host} couldn't be found` }
  const local = addresses.find((a) => privateAddress(a.address))
  if (local) return { why: `web_fetch reads public pages only: ${host} is ${local.address}` }
  return { address: addresses[0]!.address }
}

/** Why `url` isn't a public page to fetch, or undefined when it is. */
export async function refuseUrl(url: URL, env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  const checked = await checkUrl(url, env)
  return "why" in checked ? checked.why : undefined
}

interface Answer {
  status: number
  header(name: string): string | undefined
  /** Up to `max` bytes of the body, then the rest dropped. */
  read(max: number): Promise<Buffer>
}

/** A GET to the checked address itself, with the name as the Host header and the TLS name, so no second lookup happens. */
function getAt(url: URL, address: string, headers: Record<string, string>, signal: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const https = url.protocol === "https:"
    const name = url.hostname.replace(/^\[|\]$/g, "")
    const req = (https ? httpsRequest : httpRequest)(
      {
        host: address,
        port: url.port || (https ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { ...headers, host: url.host },
        signal,
        ...(https && !isIP(name) ? { servername: name } : {}),
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          header: (h) => {
            const v = res.headers[h.toLowerCase()]
            return Array.isArray(v) ? v[0] : v
          },
          read: async (max) => {
            const chunks: Buffer[] = []
            let size = 0
            for await (const chunk of res) {
              chunks.push(chunk as Buffer)
              size += (chunk as Buffer).length
              if (size >= max) break
            }
            res.destroy()
            return Buffer.concat(chunks)
          },
        })
      },
    )
    req.on("error", reject)
    req.end()
  })
}

/** The same GET by fetch, for a name only the proxy can look up: the proxy looks it up and connects. */
async function getByFetch(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Answer> {
  const res = await fetch(url, { redirect: "manual", signal, headers })
  return {
    status: res.status,
    header: (h) => res.headers.get(h) ?? undefined,
    read: async (max) => {
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (reader && size < max) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.length
      }
      await reader?.cancel().catch(() => {})
      return Buffer.concat(chunks)
    },
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

/** A page's readable text: scripts, styles and tags out, blocks on their own lines, entities decoded. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/pre|\/blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// What a page can hide from a reader and still hand a model: controls (an escape sequence's start among
// them), direction marks, and every other character that draws nothing, Unicode's tag characters included.
// Line breaks, tabs, the joiners and an emoji's selector stay. The same characters the core's own cleaner
// drops from text it draws; written out here because this file stands alone.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|(?!\u200d)\p{Cf}|(?![\u200c\u200d\ufe0e\ufe0f])\p{Default_Ignorable_Code_Point}/gu

/** A fetched page's text as the model gets it: what the person would see, with nothing hidden riding along. */
export function shownText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n").replace(HIDDEN, "")
}

/** Fetches a public page's text, following up to five redirects, each checked as the first was (by `check`, which tests replace). */
export async function fetchText(raw: string, o: { signal?: AbortSignal; check?: (url: URL) => Promise<Checked> } = {}): Promise<string> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${raw} isn't a URL`)
  }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const both = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  for (let hop = 0; ; hop++) {
    const checked = await (o.check ?? checkUrl)(url)
    if ("why" in checked) throw new Error(checked.why)
    const headers = { "user-agent": "candle-harness web_fetch", accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1" }
    const res = checked.address ? await getAt(url, checked.address, headers, both) : await getByFetch(url, headers, both)
    const location = res.header("location")
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= 5) throw new Error(`${raw} redirected too many times`)
      await res.read(0)
      url = new URL(location, url)
      continue
    }
    if (res.status < 200 || res.status > 299) throw new Error(`${url.href} answered HTTP ${res.status}`)
    const type = (res.header("content-type") ?? "").toLowerCase()
    if (type && !/^text\/|json|xml|javascript/.test(type)) throw new Error(`${url.href} isn't a text page (${type.split(";")[0]})`)
    const body = new TextDecoder().decode(await res.read(MAX_BYTES))
    const text = shownText(/html/.test(type) || /^\s*<(!doctype|html)/i.test(body) ? pageText(body) : body.trim())
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[cut at ${MAX_CHARS} characters]` : text
  }
}

export default function candleGate(pi: any) {
  const dir = process.env.CANDLE_HARNESS_RESEARCH_DIR
  if (!dir) throw new Error("the Candle gate needs CANDLE_HARNESS_RESEARCH_DIR")
  const research = realpathSync(dir) // throws, and so stops Pi, when the folder isn't there
  const home = homedir()
  const shell = gateShell(process.env.CANDLE_GATE_SHELL)
  const offered = process.env.CANDLE_GATE_TOOLS === undefined ? undefined : process.env.CANDLE_GATE_TOOLS.split(",")
  const on = (name: string) => offered === undefined || offered.includes(name)
  pi.on("tool_call", async (event: { toolName: string; input: Record<string, unknown> }) => {
    const name = event.toolName
    if (name.startsWith("mcp__candle__")) return undefined
    if (name === WEB_FETCH && on(name)) return undefined
    if (name === "bash" && shell !== "off") {
      if (shellAllows(shell, event.input?.command as string)) return undefined
      return { block: true, reason: `Your shell runs only ${(shell as string[]).join(", ")}, one plain command at a time: no ;, &&, |, redirects or $(…)` }
    }
    if (!FILE_TOOLS.includes(name) || !on(name)) return { block: true, reason: `${name} isn't available to the Candle agent` }
    const check = checkPath(name, event.input?.path, research, home)
    if (!check.ok) return { block: true, reason: check.reason }
    // Pi runs the tool with this same object, so it opens exactly the path checked.
    event.input.path = check.path
    return undefined
  })
  pi.registerTool({
    name: WEB_FETCH,
    label: "Web fetch",
    description: `Fetch a public web page by its full http or https URL and return its text, up to ${MAX_CHARS} characters. It can't read files or local addresses. There's no web search.`,
    parameters: { type: "object", properties: { url: { type: "string", description: "The page's full http or https URL" } }, required: ["url"], additionalProperties: false },
    async execute(_id: string, params: { url: string }, signal?: AbortSignal) {
      return { content: [{ type: "text", text: await fetchText(params.url, { signal }) }], details: undefined }
    },
  })
}
