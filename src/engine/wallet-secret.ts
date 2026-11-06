// A wallet's own secret pasted into a message to the agent: a Solana keypair, as base58 or as the 64-number
// array a keypair file holds, or a recovery phrase. Each is told apart exactly, never by its shape alone,
// so a transaction signature (64 bytes too) or a sentence of ordinary words is never refused:
//   - a keypair is 64 bytes whose last 32 are the ed25519 public key of the first 32;
//   - a recovery phrase is 12, 15, 18, 21 or 24 words of BIP-39's English list whose checksum holds.
// A bare 32-byte seed reads exactly as an address does, so it can't be told apart and isn't refused.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import WORDS from "./bip39-english.txt" with { type: "text" }

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
// A 64-byte value in base58 is 86 to 88 characters; a little either side costs nothing.
const BASE58_SECRET = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![0-9A-Za-z])/g
const BYTE_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*,?\s*\]/g
// PKCS#8's wrapping for a raw ed25519 seed, so node's crypto can derive its public key.
const ED25519_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
const PHRASE_LENGTHS = [24, 21, 18, 15, 12]

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
function isKeypair(bytes: Buffer): boolean {
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

/**
 * Whether a run of words holds a recovery phrase, however it was pasted: one a line or space, numbered,
 * quoted, as a JSON list, joined by commas or hyphens, in any case, or ending a sentence. Anything that
 * isn't a letter separates words; a word not on the list breaks a run.
 */
function hasPhrase(text: string): boolean {
  const list = words()
  let run: number[] = []
  const runs: number[][] = []
  for (const t of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (t === "") continue
    const i = list.get(t)
    if (i === undefined) {
      if (run.length) runs.push(run)
      run = []
    } else run.push(i)
  }
  if (run.length) runs.push(run)
  for (const r of runs) {
    for (const n of PHRASE_LENGTHS) {
      for (let at = 0; at + n <= r.length; at++) if (checksumHolds(r.slice(at, at + n))) return true
    }
  }
  return false
}

/** Whether `text` holds a wallet's keypair or recovery phrase. */
export function walletSecretIn(text: string): boolean {
  for (const [word] of text.matchAll(BASE58_SECRET)) if (isKeypair(base58Bytes(word))) return true
  for (const [array] of text.matchAll(BYTE_ARRAY)) {
    const numbers = array.match(/\d+/g)!.map(Number)
    if (numbers.every((n) => n <= 255) && isKeypair(Buffer.from(numbers))) return true
  }
  return hasPhrase(text)
}
