/**
 * The core's redactor. Every journal row, every event a view receives and every
 * text a model sees passes through it first.
 *
 * It removes three things:
 *   - the exact values the core holds (each agent's key, registered as it is loaded), so a secret is
 *     caught whatever shape it is in;
 *   - the value of an `api-key=`, `api_key=`, `apikey=`, `key=`, `token=`, `access_token=`, `refresh_token=`,
 *     `id_token=`, `password=`, `client_secret=`, `secret=` or `dkey=` URL parameter, a Bearer token, a Basic
 *     credential, and a URL's `user:pass@`;
 *   - a JWT, an RPC provider's key in its URL's path (QuickNode, Alchemy, Infura, Ankr, and the like), and a
 *     keypair file's 64-number array;
 *   - anything shaped like a Candle API key (`cndl_live_` / `cndl_test_`), held or not;
 *   - anything shaped like a code bot's or a Build pane's token (`chb_` / `chd_`), which live outside the core;
 *   - anything shaped like another service's key or token (Anthropic, OpenAI, OpenRouter, xAI, GitHub,
 *     GitLab, Slack, AWS, Google, Stripe, Hugging Face) or a PEM private key, since people paste their
 *     own into the chat. Each is matched by its prefix and a length, so prose and ids survive. A Solana
 *     private key isn't matched: in base58 it's shaped like a transaction signature, which must show.
 *
 * Redaction is by replacement with {@link REDACTED}, never by dropping the field, so a reader can
 * see that something was there.
 */

import { isKeypair } from "./wallet-secret"

export const REDACTED = "[redacted]"

/** A Candle API key, by the server's prefix rule (profiles.ts `apiKeyPrefix`). */
const API_KEY_SHAPE = /cndl_(?:live|test)_[A-Za-z0-9_-]+/g
/** A code bot's or a Build pane's token: `chb_` or `chd_`, a 12-character id, `_`, and the secret. */
const HARNESS_TOKEN_SHAPE = /(?<![A-Za-z0-9_])ch[bd]_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{20,}/g
/** `?api-key=...`, `&api_key=...`, `key=...`, `token=...`, `refresh_token=...`, `password=...`, `client_secret=...` in a URL or query string. */
const KEY_PARAM = /([?&;](?:api[-_]?key|key|dkey|token|access_token|refresh_token|id_token|password|passwd|client_secret|secret)=)[^&\s"'#]+/gi
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi
/** `Basic <base64 of user:pass>`: replaced only where it decodes to a `user:pass`, so "Basic information" stays. */
const BASIC = /(\bBasic\s+)([A-Za-z0-9+/]{6,}={0,2})(?![A-Za-z0-9+/=])/g
/** A URL's `user:pass@` (or a lone token as its user): the credentials before the host. */
const USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi
/** A JWT: a base64url header and payload, each a JSON object (`eyJ`), and its signature. */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
/** An RPC provider's URL, whose key sits in its path: each long path segment of it is replaced. */
const RPC_PATH_URL = /\bhttps?:\/\/(?:[A-Za-z0-9-]+\.)*(?:quiknode\.pro|alchemy\.com|alchemyapi\.io|infura\.io|ankr\.com|chainstack\.com|p2pify\.com|getblock\.io|blastapi\.io|drpc\.org|nodereal\.io|rpcpool\.com|syndica\.io|shyft\.to|extrnode\.com|helius-rpc\.com|tatum\.io|blockdaemon\.com)(?::\d+)?\/[^\s"'<>?#]*/gi
const LONG_SEGMENT = /(?<=\/)[A-Za-z0-9_-]{16,}(?=\/|$)/g
/** A keypair file's 64 numbers, which is the whole secret key: replaced only where they are one (wallet-secret.ts), so 64 bytes of anything else show. */
const KEYPAIR_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*,?\s*\]/g

/** Whether a 64-number array is an ed25519 keypair: its last 32 bytes the public key of its first 32. */
const keypairArray = (array: string): boolean => {
  const bytes = (array.match(/\d{1,3}/g) ?? []).map(Number)
  return bytes.length === 64 && bytes.every((b) => b <= 255) && isKeypair(Buffer.from(bytes))
}

/** Whether a Basic credential decodes to `user:pass` in plain text. */
const isBasicCredential = (b64: string): boolean => {
  const text = Buffer.from(b64, "base64").toString("utf8")
  return /^[\x20-\x7e]+$/.test(text) && text.includes(":")
}
/** Other services' keys and tokens, by each one's published prefix. None of these can occur in base58. */
const OTHER_KEY_SHAPES: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])sk-(?:ant-|proj-|or-v1-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI, OpenRouter
  /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{40,}/g, // xAI
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{40,}/g, // GitHub fine-grained tokens
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key ids
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, // Stripe
  /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, // a PEM private key, to its end
]

/** Below this length a value is not registered: redacting a 3-character string would shred text. */
const MIN_SECRET_LENGTH = 8

/** Field names whose value is never written, whatever it holds: no passphrase, key or factor value. */
const FORBIDDEN_FIELDS = new Set([
  "passphrase",
  "password",
  "apikey",
  "api_key",
  "devicetoken",
  "device_token",
  "secret",
  // A wallet's own secret, as a keypair or a recovery phrase holds it, and an OAuth client's or refresh token.
  "privatekey",
  "private_key",
  "secretkey",
  "secret_key",
  "mnemonic",
  "seed",
  "seedphrase",
  "seed_phrase",
  "client_secret",
  "refresh_token",
])

export class Redactor {
  private readonly secrets = new Set<string>()
  /** The secrets longest first, so a secret that contains another is replaced whole. Kept between changes, since every string the core sends passes through. */
  private ordered: string[] = []

  /** Registers a value the core holds. Blank and very short values are ignored. */
  add(value: string | undefined | null): void {
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (trimmed.length < MIN_SECRET_LENGTH || this.secrets.has(trimmed)) return
    this.secrets.add(trimmed)
    this.order()
  }

  /** Forgets a value, for a credential the core no longer holds. */
  remove(value: string): void {
    if (this.secrets.delete(value.trim())) this.order()
  }

  /** How many values it holds. */
  get size(): number {
    return this.secrets.size
  }

  private order(): void {
    this.ordered = [...this.secrets].sort((a, b) => b.length - a.length)
  }

  text(input: string): string {
    let out = input
    for (const secret of this.ordered) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED)
    }
    out = out.replace(API_KEY_SHAPE, REDACTED)
    out = out.replace(HARNESS_TOKEN_SHAPE, REDACTED)
    for (const shape of OTHER_KEY_SHAPES) out = out.replace(shape, REDACTED)
    out = out.replace(JWT, REDACTED).replace(KEYPAIR_ARRAY, (array) => (keypairArray(array) ? REDACTED : array))
    out = out.replace(RPC_PATH_URL, (url) => url.replace(LONG_SEGMENT, REDACTED))
    out = out.replace(USERINFO, `$1${REDACTED}@`)
    out = out.replace(BASIC, (whole, lead: string, b64: string) => (isBasicCredential(b64) ? `${lead}${REDACTED}` : whole))
    return out.replace(KEY_PARAM, `$1${REDACTED}`).replace(BEARER, `$1${REDACTED}`)
  }

  /** A deep copy of `value` with every string redacted and every forbidden field's value replaced. */
  value<T>(value: T): T {
    return this.walk(value, 0) as T
  }

  private walk(value: unknown, depth: number): unknown {
    if (depth > 32) return REDACTED
    if (typeof value === "string") return this.text(value)
    if (Array.isArray(value)) return value.map((item) => this.walk(item, depth + 1))
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        const lower = key.toLowerCase()
        if (FORBIDDEN_FIELDS.has(lower)) out[key] = REDACTED
        // A factor keeps its type and loses its value, so a record can say which factor was used,
        // never what it was. The core never takes a factor over the socket; this is a backstop.
        else if (lower === "factor") out[key] = this.walk(withoutFactorValue(inner), depth + 1)
        else out[key] = this.walk(inner, depth + 1)
      }
      return out
    }
    return value
  }
}

/** Replaces a factor's value, keeping its type: `{type: "passphrase", value}` -> `{type: "passphrase"}`. */
export function withoutFactorValue(factor: unknown): unknown {
  if (factor === null || typeof factor !== "object") return factor
  const { value: _dropped, ...rest } = factor as Record<string, unknown>
  return rest
}
