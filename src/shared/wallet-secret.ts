// A wallet's own secret pasted into a message to the agent: a Solana keypair, as base58, hex, base64 or the
// 64-number array a keypair file holds, or a recovery phrase. Each is told apart exactly, never by its shape alone,
// so a transaction signature (64 bytes too) or a sentence of ordinary words is never refused:
//   - a keypair is 64 bytes whose last 32 are the ed25519 public key of the first 32;
//   - a recovery phrase is 12, 15, 18, 21 or 24 words of BIP-39's English list whose checksum holds;
//   - an EVM private key is 32 bytes of hex, the same shape as a transaction hash, so it's refused only when it's
//     the key of a wallet the account holds (its address worked out exactly), or when words just before it name it
//     a private key ("my private key is 0x…", "pk: 0x…"). A transaction hash passes bare, and in a sentence unless
//     it's named a key that way; words after it, or with other words between, don't count.
// A bare 32-byte Solana seed reads exactly as an address does, so it can't be told apart and isn't refused.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import WORDS from "./bip39-english.txt" with { type: "text" }
import { addressKey } from "./chains"
import { evmAddressOf } from "./secp256k1"

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
// A 64-byte value in base58 is 86 to 88 characters; a little either side costs nothing.
const BASE58_SECRET = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![0-9A-Za-z])/g
// The same 64 bytes as hex (128 digits, with or without 0x) or as base64 (86 characters and its padding).
const HEX_SECRET = /(?<![0-9A-Za-z])(?:0x)?([0-9a-fA-F]{128})(?![0-9A-Za-z])/g
const BASE64_SECRET = /(?<![0-9A-Za-z+/_=-])[0-9A-Za-z+/_-]{86}(?:==)?(?![0-9A-Za-z+/_=-])/g
const BYTE_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*,?\s*\]/g
// PKCS#8's wrapping for a raw ed25519 seed, so node's crypto can derive its public key.
const ED25519_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
const PHRASE_LENGTHS = [24, 21, 18, 15, 12]
// 32 bytes as hex, with or without 0x (or 0X): an EVM private key's shape, and a transaction hash's. A fixed count
// between two one-character edges, so the search is linear on any input.
const EVM_HEX = /(?<![0-9A-Za-z])(?:0[xX])?[0-9a-fA-F]{64}(?![0-9A-Za-z])/g
// Words that name the value straight after them a private key: whole words only, so "secretary" or "pkg" don't,
// then nothing but separators (spaces, quotes, ":", "=", brackets, dashes) and at most an "is" or "was", to the
// value's start. Read over the few characters just before the value, anchored at its start.
const NAMED_BEFORE = /[^a-z0-9](?:private[\s_-]*key|priv[\s_-]*key|privkey|secret|seed|pk)[\s"'`:=(\[{<>\-–—]*(?:(?:is|was)[\s"'`:=(\[{<>\-–—]*)?$/i
// How far back the words can start: room for "private key" and its joining phrase.
const NEAR_BEFORE = 40

let wordIndex: Map<string, number> | undefined
const words = () => (wordIndex ??= new Map(WORDS.split("\n").map((w, i) => [w.trim(), i] as const).filter(([w]) => w !== "")))

/** The bytes a base58 string decodes to. */
function base58Bytes(s: string): Buffer {
  let n = 0n
  for (const ch of s) n = n * 58n + BigInt(BASE58.indexOf(ch))
  const out: number[] = []
  while (n > 0n) {
    out.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  let zeros = 0
  while (s[zeros] === "1") zeros++
  return Buffer.from([...Array<number>(zeros).fill(0), ...out])
}

/** Whether 64 bytes are an ed25519 keypair: a seed, then its own public key. */
export function isKeypair(bytes: Buffer): boolean {
  if (bytes.length !== 64) return false
  try {
    const key = createPrivateKey({ key: Buffer.concat([ED25519_SEED_PREFIX, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" })
    return createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).equals(bytes.subarray(32))
  } catch {
    return false
  }
}

/** Whether these words' indexes in BIP-39's list carry a valid checksum. */
function checksumHolds(indexes: readonly number[]): boolean {
  const bits = indexes.map((i) => i.toString(2).padStart(11, "0")).join("")
  const checksumBits = indexes.length / 3
  const entropyBits = bits.slice(0, bits.length - checksumBits)
  const entropy = Buffer.from(entropyBits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))
  const hash = createHash("sha256").update(entropy).digest()
  const want = [...hash].map((b) => b.toString(2).padStart(8, "0")).join("").slice(0, checksumBits)
  return bits.slice(bits.length - checksumBits) === want
}

/** A word that labels the next one ("word 3:", "key 3 -", "seed word #3 ="): the token just before a number and its mark. */
const LABELLED = /^\s*#?\d{1,2}\s*[:=)\-–—]/

/**
 * Whether a run of words holds a recovery phrase, however it was pasted: one a line or space, numbered,
 * quoted, as a JSON list, joined by commas or hyphens, in any case, or ending a sentence. Anything that
 * isn't a letter separates words; a word not on the list breaks a run.
 *
 * A phrase pasted with a label on each word ("word 1: …, word 2: …") is read with its labels gone: the
 * word before each number-and-mark is left out, and so is any word a run repeats three times or more,
 * which a label does and a phrase's own words rarely do. The checksum still has to hold over what's left,
 * so nothing is refused for its shape.
 */
function hasPhrase(text: string): boolean {
  const list = words()
  const lower = text.toLowerCase()
  const tokens = [...lower.matchAll(/\p{L}+/gu)].map((m) => ({ index: list.get(m[0]), label: LABELLED.test(lower.slice(m.index + m[0].length, m.index + m[0].length + 8)) }))
  const runsOf = (dropLabels: boolean): number[][] => {
    const runs: number[][] = []
    let run: number[] = []
    for (const t of tokens) {
      if (dropLabels && t.label) continue
      if (t.index === undefined) {
        if (run.length) runs.push(run)
        run = []
      } else run.push(t.index)
    }
    if (run.length) runs.push(run)
    return runs
  }
  const holds = (r: readonly number[]) => PHRASE_LENGTHS.some((n) => {
    for (let at = 0; at + n <= r.length; at++) if (checksumHolds(r.slice(at, at + n))) return true
    return false
  })
  const withoutRepeats = (r: readonly number[]) => {
    const counts = new Map<number, number>()
    for (const i of r) counts.set(i, (counts.get(i) ?? 0) + 1)
    return r.filter((i) => counts.get(i)! < 3)
  }
  // The same one or two words before every word of the run ("word: …, word: …"), a label even when the
  // phrase holds that word itself: what stands after each.
  const afterEvery = (r: readonly number[]): number[][] =>
    [2, 3].filter((k) => r.length >= 12 * k && r.every((v, i) => i % k === k - 1 || i < k || v === r[i - k])).map((k) => r.filter((_, i) => i % k === k - 1))
  const plain = runsOf(false)
  const unlabelled = tokens.some((t) => t.label) ? runsOf(true) : []
  for (const r of [...plain, ...unlabelled]) {
    if (holds(r)) return true
    const fewer = withoutRepeats(r)
    if (fewer.length !== r.length && holds(fewer)) return true
    if (afterEvery(r).some(holds)) return true
  }
  return false
}

/** What the core knows to tell an EVM key apart: whether an address (by addressKey) is one of the account's own wallets. */
export interface SecretContext {
  ownEvm?: (addressKey: string) => boolean
}

/** Whether the words just before the value starting at `start` name it a private key. */
function namedAKey(text: string, start: number): boolean {
  const from = Math.max(0, start - NEAR_BEFORE)
  // The text's own start counts as an edge; a cut into the middle of a word doesn't.
  return NAMED_BEFORE.test(`${from === 0 ? " " : ""}${text.slice(from, start)}`)
}

/** A check of 32-byte hex values against the account's own wallets, each distinct value worked out once. */
function ownKeyCheck(ctx: SecretContext): (whole: string) => boolean {
  const own = new Map<string, boolean>()
  return (whole) => {
    if (!ctx.ownEvm) return false
    const hex = whole.replace(/^0x/i, "").toLowerCase()
    let isOwn = own.get(hex)
    if (isOwn === undefined) {
      const address = evmAddressOf(Buffer.from(hex, "hex"))
      isOwn = address !== undefined && ctx.ownEvm(addressKey(address))
      own.set(hex, isOwn)
    }
    return isOwn
  }
}

/** The EVM private keys in `text`, as written: each 32-byte hex value named a key just before it, or whose address is one of the account's own wallets. */
export function evmKeysIn(text: string, ctx: SecretContext = {}): string[] {
  const isOwn = ownKeyCheck(ctx)
  return [...text.matchAll(EVM_HEX)].filter((m) => namedAKey(text, m.index) || isOwn(m[0])).map((m) => m[0])
}

/**
 * The keys in `text`, as written, of the account's own wallets: only these are known to be keys whatever words
 * go with them, so only these are worth keeping out of every log after. A value named a key by its words alone may
 * be anything; the words take it out wherever they go with it.
 */
export function ownEvmKeysIn(text: string, ctx: SecretContext = {}): string[] {
  const isOwn = ownKeyCheck(ctx)
  return [...text.matchAll(EVM_HEX)].filter((m) => isOwn(m[0])).map((m) => m[0])
}

/** `text` with each 32-byte hex value named a private key just before it replaced: what any log can do with no wallet list. */
export function withoutEvmKeysByContext(text: string, replacement: string): string {
  return text.replace(EVM_HEX, (whole: string, offset: number) => (namedAKey(text, offset) ? replacement : whole))
}

/** Whether `text` holds a wallet's keypair, recovery phrase or EVM private key. */
export function walletSecretIn(text: string, ctx: SecretContext = {}): boolean {
  for (const [word] of text.matchAll(BASE58_SECRET)) if (isKeypair(base58Bytes(word))) return true
  for (const [, hex] of text.matchAll(HEX_SECRET)) if (isKeypair(Buffer.from(hex!, "hex"))) return true
  for (const [word] of text.matchAll(BASE64_SECRET)) if (isKeypair(Buffer.from(word.replace(/-/g, "+").replace(/_/g, "/"), "base64"))) return true
  for (const [array] of text.matchAll(BYTE_ARRAY)) {
    const numbers = array.match(/\d+/g)!.map(Number)
    if (numbers.every((n) => n <= 255) && isKeypair(Buffer.from(numbers))) return true
  }
  if (evmKeysIn(text, ctx).length > 0) return true
  return hasPhrase(text)
}
