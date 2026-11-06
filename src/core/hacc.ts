// The core's client for Hacc (`api.hacc.fun`), Candle's market data engine. Candle
// doesn't proxy it and no MCP tool reads it, so the core calls Hacc's documented routes itself
// (docs.candle.tv docs.candle.tv/developers/data-and-strategy-api), with the calling agent's own key as the bearer
// token. The host is fixed: only tests point it elsewhere, through the core's options. A redirect is
// refused, never followed, so the key can't be carried to another host.
//
// Hacc reads the account, not the key (the docs), so a read is cached a short while for every agent on
// the same account: two agents asking the same thing cost one call. An agent whose key Hacc refused
// never reads the cache, so a revoked key's agent learns nothing from another's.
//
// Hacc's real answers set the timeouts and the words: Hacc refuses any parameter
// it doesn't know, in Zod's words naming the field, and those words are passed on so the agent can fix
// its call.
import { createHash } from "node:crypto"
import { Redactor } from "../shared/redact"
import { utf8Bytes } from "./usage"

export const HACC_HOST = "https://api.hacc.fun"

/** Measured on Hacc's real server: market activity takes 24 to 28 s, runners 18 s at an hour, first signals and assets 5 to 12 s. */
const TIMEOUTS: [RegExp, number][] = [
  [/^\/v1\/market\/activity$/, 45_000],
  [/^\/v1\/strategy-lab\/runners$/, 30_000],
  [/^\/v1\/strategy-lab\/first-signals$/, 20_000],
  [/^\/v1\/assets$/, 20_000],
  [/^\/v1\/market\/wallet\/[^/]+\/book-legs$/, 15_000],
]
export const DEFAULT_TIMEOUT_MS = 5_000
export const timeoutFor = (route: string) => TIMEOUTS.find(([re]) => re.test(route))?.[1] ?? DEFAULT_TIMEOUT_MS

export type HaccCode =
  | "HACC_KEY_REFUSED" // 401: a test, revoked, expired or unknown key
  | "PLAN_REQUIRED" // 403: the account's plan doesn't reach it
  | "HACC_LIMIT" // 429: a cap or quota
  | "HACC_NOT_FOUND" // 404
  | "HACC_BUSY" // 409: a replay already running on this key
  | "HACC_BAD_REQUEST" // 400: Hacc's own words name what's wrong
  | "HACC_FAILED" // 5xx
  | "HACC_NO_ANSWER" // no answer in time, or no connection
  | "HACC_REDIRECT_REFUSED" // Hacc answered with a redirect, which the core never follows
  | "HACC_NO_KEY" // the agent has no key the core can send

export type HaccAnswer =
  | { kind: "ok"; status: number; body: unknown; ms: number; cached: boolean }
  | { kind: "refused"; code: HaccCode; message: string; status?: number; plan?: "pro" | "max"; quota?: number; used?: number; jobId?: number; ms: number }

export interface HaccDeps {
  keyFor(agent: string): string | undefined
  /** The account an agent's key belongs to, when known (its embedded wallet): agents on one account share the cache. */
  accountOf?(agent: string): string | undefined
  now(): number
  /** Tests only: the fake Hacc's address. */
  host?: string
  fetch?: typeof fetch
  /** Each read Hacc answered, with its body's size, for the core's usage totals. */
  onRead?: (bytes: number) => void
}

interface Cached {
  at: number
  answer: Extract<HaccAnswer, { kind: "ok" }>
}

/** Cached answers kept at most, oldest dropped first: each is Hacc's whole body, and a core runs for days. */
export const HACC_CACHE_MAX = 500

/** Hacc's error body's words: `{error}`, or Fastify's `{message}`. */
function wordsOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>
    if (typeof b.error === "string" && b.error && b.error !== "Not Found") return b.error
    if (typeof b.message === "string" && b.message) return b.message
  }
  return typeof body === "string" && body.trim() ? body.trim().slice(0, 300) : fallback
}
/**
 * Hacc's `next_after` as it came, as text for the next page's `after`. On `/v1/me/signals` it's a whole number,
 * and Hacc refuses a date there ("after: Expected number"; checked live), so a cursor is never made up.
 */
export const haccCursor = (value: unknown): string | undefined =>
  typeof value === "number" ? (Number.isSafeInteger(value) && value > 0 ? String(value) : undefined) : typeof value === "string" && value.length > 0 ? value : undefined

const numberOf = (body: unknown, field: string): number | undefined => {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined
  return typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined
}

export class HaccClient {
  private readonly host: string
  private readonly doFetch: typeof fetch
  private readonly cache = new Map<string, Cached>()
  /** The longest any read has asked an answer to be kept: past it, nobody reads one, so it goes. */
  private longestCacheMs = 0
  /** Each agent whose key Hacc refused: the words, and which key, so a new key starts afresh. */
  private readonly refusedKeys = new Map<string, { message: string; key: string | undefined }>()
  /** The last refusal, for the `hacc` topic and the doctor. No key, no rows. */
  lastRefusal: { agent: string; code: HaccCode; message: string; at: number } | undefined

  constructor(private readonly deps: HaccDeps) {
    this.host = deps.host ?? HACC_HOST
    this.doFetch = deps.fetch ?? fetch
  }

  /** Whether Hacc last refused this agent's key, and in what words. A key changed since is unrefused. */
  keyRefused(agent: string): string | undefined {
    const held = this.refusedKeys.get(agent)
    return held && held.key === this.fingerprint(agent) ? held.message : undefined
  }

  private fingerprint(agent: string): string | undefined {
    const key = this.deps.keyFor(agent)
    return key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : undefined
  }

  /** Hacc refused this agent's key (a 401, here or on the stream's upgrade): its agent reads nothing until one answers. */
  noteKeyRefused(agent: string, words: string): string {
    const message = `Hacc refused ${agent}'s key (${words}). Hacc takes only a live, unrevoked production key (cndl_live_).`
    this.refusedKeys.set(agent, { message, key: this.fingerprint(agent) })
    this.lastRefusal = { agent, code: "HACC_KEY_REFUSED", message, at: this.deps.now() }
    return message
  }

  /** A read. `cacheMs` keeps the answer that long for every agent on the account. */
  async get(agent: string, route: string, query: Record<string, string | number | boolean | undefined> = {}, o: { cacheMs?: number; timeoutMs?: number } = {}): Promise<HaccAnswer> {
    const q = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)] as [string, string])
      .sort(([a], [b]) => a.localeCompare(b))
    const cacheKey = `${this.deps.accountOf?.(agent) ?? `agent:${agent}`} GET ${route}?${new URLSearchParams(q)}`
    const held = this.cache.get(cacheKey)
    if (o.cacheMs && held && this.deps.now() - held.at < o.cacheMs && !this.keyRefused(agent)) return { ...held.answer, cached: true }
    const answer = await this.call(agent, "GET", route, q, undefined, o.timeoutMs)
    if (answer.kind === "ok" && o.cacheMs) this.keep(cacheKey, answer, o.cacheMs)
    return answer
  }

  private keep(cacheKey: string, answer: Cached["answer"], cacheMs: number): void {
    const now = this.deps.now()
    this.longestCacheMs = Math.max(this.longestCacheMs, cacheMs)
    for (const [k, held] of this.cache) if (now - held.at >= this.longestCacheMs) this.cache.delete(k)
    // Set last, so the map's order is oldest first.
    this.cache.delete(cacheKey)
    this.cache.set(cacheKey, { at: now, answer })
    for (const k of this.cache.keys()) {
      if (this.cache.size <= HACC_CACHE_MAX) break
      this.cache.delete(k)
    }
  }

  /** How many answers are cached, for tests. */
  cachedCount(): number {
    return this.cache.size
  }

  /** A change: POST, PATCH or DELETE. Never cached, and it clears the account's cached reads. */
  async send(agent: string, method: "POST" | "PATCH" | "DELETE", route: string, body?: unknown, o: { timeoutMs?: number } = {}): Promise<HaccAnswer> {
    const answer = await this.call(agent, method, route, [], body, o.timeoutMs)
    const account = this.deps.accountOf?.(agent) ?? `agent:${agent}`
    if (answer.kind === "ok") for (const k of [...this.cache.keys()]) if (k.startsWith(`${account} `)) this.cache.delete(k)
    return answer
  }

  private async call(agent: string, method: string, route: string, query: [string, string][], body: unknown, timeoutMs?: number): Promise<HaccAnswer> {
    const started = this.deps.now()
    const ms = () => this.deps.now() - started
    const key = this.deps.keyFor(agent)
    if (!key) return this.refuse(agent, { kind: "refused", code: "HACC_NO_KEY", message: `${agent} has no key the core can send to Hacc.`, ms: 0 })
    const redactor = new Redactor()
    redactor.add(key)
    const url = new URL(route, this.host)
    if (url.origin !== new URL(this.host).origin) return { kind: "refused", code: "HACC_BAD_REQUEST", message: "Only Hacc's own routes can be read.", ms: 0 }
    for (const [k, v] of query) url.searchParams.set(k, v)
    const limit = timeoutMs ?? timeoutFor(route)
    let res: Response
    try {
      res = await this.doFetch(url, {
        method,
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(limit),
      })
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
      return this.refuse(agent, {
        kind: "refused",
        code: "HACC_NO_ANSWER",
        message: timedOut ? `Hacc didn't answer in ${Math.round(limit / 1000)} s.` : `Hacc couldn't be reached: ${redactor.text(e instanceof Error ? e.message : String(e))}`,
        ms: ms(),
      })
    }
    // `manual` rather than `error`, so the answer can say what happened; nothing is followed either way.
    if (res.status >= 300 && res.status < 400)
      return this.refuse(agent, { kind: "refused", code: "HACC_REDIRECT_REFUSED", status: res.status, message: "Hacc answered with a redirect, which the core doesn't follow, so nothing was read.", ms: ms() })
    const text = await res.text().catch(() => "")
    this.deps.onRead?.(utf8Bytes(text))
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    const answerBody = redactor.value(parsed)
    if (res.ok) {
      if (this.refusedKeys.delete(agent) && this.lastRefusal?.agent === agent) this.lastRefusal = undefined
      return { kind: "ok", status: res.status, body: answerBody, ms: ms(), cached: false }
    }
    const words = redactor.text(wordsOf(parsed, `HTTP ${res.status}`))
    const status = res.status
    if (status === 401) return this.refuse(agent, { kind: "refused", code: "HACC_KEY_REFUSED", status, message: this.noteKeyRefused(agent, words), ms: ms() })
    if (status === 403) {
      const plan = /max/i.test(words) && !/pro/i.test(words) ? "max" : "pro"
      return this.refuse(agent, { kind: "refused", code: "PLAN_REQUIRED", status, plan, message: `This needs Candle's ${plan === "max" ? "Max" : "Pro or Max"} plan (Hacc: ${words}).`, ms: ms() })
    }
    if (status === 429) {
      // A cap names its size `quota`, or `limit` (book legs' snapshots), and may say when it frees up.
      const quota = numberOf(parsed, "quota") ?? numberOf(parsed, "limit")
      const used = numberOf(parsed, "used")
      const retry = numberOf(parsed, "retry_after_s")
      const again = retry !== undefined ? `; it frees up in about ${Math.max(1, Math.ceil(retry / 60))} min` : ""
      return this.refuse(agent, { kind: "refused", code: "HACC_LIMIT", status, message: `Hacc's limit: ${words}${quota !== undefined ? ` (${used ?? "?"} of ${quota} used)` : ""}${again}.`, ...(quota !== undefined ? { quota } : {}), ...(used !== undefined ? { used } : {}), ms: ms() })
    }
    if (status === 409) {
      const jobId = numberOf(parsed, "job_id")
      return this.refuse(agent, { kind: "refused", code: "HACC_BUSY", status, message: `Hacc: ${words}.`, ...(jobId !== undefined ? { jobId } : {}), ms: ms() })
    }
    if (status === 404) return this.refuse(agent, { kind: "refused", code: "HACC_NOT_FOUND", status, message: `Hacc: ${words}.`, ms: ms() })
    if (status >= 500) return this.refuse(agent, { kind: "refused", code: "HACC_FAILED", status, message: `Hacc failed (${status}: ${words}). It's Hacc's error, not the request's.`, ms: ms() })
    return this.refuse(agent, { kind: "refused", code: "HACC_BAD_REQUEST", status, message: `Hacc refused the request: ${words}`, ms: ms() })
  }

  private refuse(agent: string, answer: Extract<HaccAnswer, { kind: "refused" }>): HaccAnswer {
    this.lastRefusal = { agent, code: answer.code, message: answer.message, at: this.deps.now() }
    return answer
  }
}
