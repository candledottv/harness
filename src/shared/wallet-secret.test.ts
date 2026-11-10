import { expect, test } from "bun:test"
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import WORDS from "./bip39-english.txt" with { type: "text" }
import { walletSecretIn } from "./wallet-secret"

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const LIST = WORDS.split("\n").filter(Boolean)

function base58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ""
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = `1${out}`
  }
  return out
}

/** A fresh keypair, made at run time, as a wallet file holds it: the seed, then its public key. */
function keypair(): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)
  return Buffer.concat([seed, publicKey.export({ format: "der", type: "spki" }).subarray(-32)])
}

/** A recovery phrase of `n` words from fresh entropy, its checksum computed as BIP-39 does. */
function phrase(n: number, entropy = randomBytes((n / 3) * 4)): string[] {
  const hash = createHash("sha256").update(entropy).digest()
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, "0")).join("") + [...hash].map((b) => b.toString(2).padStart(8, "0")).join("").slice(0, n / 3)
  return bits.match(/.{11}/g)!.map((b) => LIST[parseInt(b, 2)]!)
}

test("the word list is BIP-39's English list", () => {
  expect(LIST).toHaveLength(2048)
  expect(createHash("sha256").update(WORDS).digest("hex")).toBe("2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda")
})

test("a wallet's keypair is found as base58 and as a keypair file's 64 numbers", () => {
  const pair = keypair()
  expect(walletSecretIn(`import this wallet and buy $5 of JUP with it: ${base58(pair)}`)).toBe(true)
  expect(walletSecretIn(`my wallet file: ${JSON.stringify([...pair])}`)).toBe(true)
  expect(walletSecretIn(`[${[...pair].join(", ")}]`)).toBe(true)
})

test("a recovery phrase of every length is found, pasted on one line, one a line or numbered", () => {
  for (const n of [12, 15, 18, 21, 24]) expect([n, walletSecretIn(`restore from ${phrase(n).join(" ")} please`)]).toEqual([n, true])
  expect(walletSecretIn(phrase(12).join("\n"))).toBe(true)
  expect(walletSecretIn(phrase(24).map((w, i) => `${i + 1}. ${w}`).join("\n"))).toBe(true)
})

test("a recovery phrase is found however it's punctuated: ending a sentence, quoted, a JSON list, joined by commas or hyphens, in any case", () => {
  const forms = (w: string[]) => [
    `my seed is ${w.join(" ")}.`,
    `"${w.join(" ")}"`,
    `'${w.join(" ")}'!`,
    JSON.stringify(w),
    w.join(","),
    w.join("-"),
    w.map((x, i) => (i % 2 ? x.toUpperCase() : x[0]!.toUpperCase() + x.slice(1))).join(" "),
    `(${w.join(", ")})?`,
  ]
  for (let i = 0; i < 20; i++) {
    for (const form of forms(phrase(i % 2 ? 24 : 12))) expect([form, walletSecretIn(form)]).toEqual([form, true])
  }
})

test("ordinary prose and lists pass, punctuation and all", () => {
  for (const text of [
    "Buy $5 of JUP. Then, if the market turns, sell half; keep the rest - above the morning high - until Friday.",
    "Check these: Final Stretch, On Fire, Graduated and New. What's the trend? I'd rather wait.",
    "notes/moon.md says: the dev wallet holds 12% and the top-10 share is 41%; liquidity's fine.",
    "agent-a, agent-b and agent-c: each has its own key, limit, wallet and memory.",
  ]) expect([text, walletSecretIn(text)]).toEqual([text, false])
})

test("what only looks like a secret passes: a signature, 64 numbers that aren't a keypair, words whose checksum fails, plain words", () => {
  // A transaction signature is 64 bytes too, but not a seed and its public key.
  expect(walletSecretIn(`it landed: ${base58(randomBytes(64))}`)).toBe(false)
  expect(walletSecretIn(JSON.stringify([...randomBytes(64)]))).toBe(false)
  // Twelve of the list's words with the last one changed: most such changes break the checksum, so take one that does.
  const words = phrase(12)
  const last = LIST.indexOf(words[11]!)
  const changed = Array.from({ length: 16 }, (_, d) => [...words.slice(0, 11), LIST[(last + d + 1) % 2048]!].join(" "))
  expect(changed.filter((w) => !walletSecretIn(w)).length).toBeGreaterThan(0)
  expect(walletSecretIn("buy $5 of JUP when the market is quiet, then sell half above the morning high")).toBe(false)
})

test("a keypair is found as hex, with or without 0x, and as base64 of either alphabet", () => {
  for (let i = 0; i < 20; i++) {
    const pair = keypair()
    for (const form of [pair.toString("hex"), `0x${pair.toString("hex")}`, pair.toString("hex").toUpperCase(), pair.toString("base64"), pair.toString("base64url"), `key: "${pair.toString("base64")}"`]) expect([form.length, walletSecretIn(`here: ${form}`)]).toEqual([form.length, true])
  }
  // The same shapes over 64 bytes that aren't a seed and its public key (a signature, a hash pair) pass.
  const other = randomBytes(64)
  for (const form of [other.toString("hex"), other.toString("base64"), other.toString("base64url")]) expect(walletSecretIn(form)).toBe(false)
})

test("a recovery phrase pasted with a label on each word is found every time", () => {
  const forms = (w: string[]) => [
    w.map((x, i) => `word ${i + 1}: ${x}`).join(", "),
    w.map((x, i) => `seed word ${i + 1}: ${x}`).join("\n"),
    w.map((x, i) => `key ${i + 1} - ${x}`).join("\n"),
    w.map((x, i) => `Word #${i + 1} = ${x}`).join("; "),
    w.map((x, i) => `mnemonic ${i + 1}) ${x}`).join(" "),
    w.map((x) => `word: ${x}`).join(", "),
  ]
  for (let i = 0; i < 300; i++) {
    for (const form of forms(phrase(i % 2 ? 24 : 12))) expect([form, walletSecretIn(form)]).toEqual([form, true])
  }
  // A phrase that holds the label's own word is still found.
  const withLabelWord = (label: string) => {
    for (;;) {
      const w = phrase(12)
      if (w.includes(label)) return w
    }
  }
  expect(walletSecretIn(withLabelWord("word").map((x) => `word: ${x}`).join(", "))).toBe(true)
  expect(walletSecretIn(withLabelWord("seed").map((x, i) => `seed word ${i + 1}: ${x}`).join(", "))).toBe(true)
})

test("labelled lists that aren't a phrase pass", () => {
  for (const text of [
    "step 1: check the market, step 2: buy half, step 3: wait, step 4: sell",
    "token 1: MOON, token 2: JUP, token 3: BONK. Rank them by volume.",
    "word 1: hello, word 2: there",
  ]) expect([text, walletSecretIn(text)]).toEqual([text, false])
})
