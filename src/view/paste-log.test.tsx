// The long-paste check: with CANDLE_HARNESS_PASTE_LOG set, each paste the terminal
// delivers is logged whole, so a script can diff it against what was pasted. Off unless set.
import { afterAll, expect, test } from "bun:test"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act } from "react"
import { drawScene } from "../../test/frame-scenes"
import { gaps, LINE } from "../../scripts/mac-checks/long-paste"
import { pasteLogger } from "./run"

const dir = mkdtempSync(join(tmpdir(), "chrn-paste-log-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))


test("off unless set, and only to an absolute path", () => {
  expect(pasteLogger({})).toBeUndefined()
  expect(pasteLogger({ CANDLE_HARNESS_PASTE_LOG: "" })).toBeUndefined()
  expect(pasteLogger({ CANDLE_HARNESS_PASTE_LOG: "paste.jsonl" })).toBeUndefined()
})

test("each paste is one line with its length, SHA-256 and text, in a private file", () => {
  const file = join(dir, "unit.jsonl")
  const log = pasteLogger({ CANDLE_HARNESS_PASTE_LOG: file })!
  log("abc")
  log("é")
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(rows.map((r) => [r.length, r.text])).toEqual([[3, "abc"], [1, "é"]])
  expect(rows[0].sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test("a paste shaped like a key keeps its length and SHA-256, never its text; the check's own line keeps its text", () => {
  const file = join(dir, "keys.jsonl")
  const log = pasteLogger({ CANDLE_HARNESS_PASTE_LOG: file })!
  const key = `sk-ant-${"x".repeat(40)}`
  log(`my key is ${key}`)
  log(LINE)
  const [secret, line] = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(secret).toMatchObject({ length: key.length + 10, sha256: expect.any(String) })
  expect(secret.text).toBeUndefined()
  expect(readFileSync(file, "utf8")).not.toContain(key)
  expect(line.text).toBe(LINE)
})

test("a bare 32-byte hex value (an own wallet's EVM key, named or not) keeps no text", () => {
  const file = join(dir, "evm.jsonl")
  const log = pasteLogger({ CANDLE_HARNESS_PASTE_LOG: file })!
  const key = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  log(`0x${key}`)
  log(key)
  log(`my private key is 0x${key}`)
  log("plain words")
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(rows.map((r) => r.text)).toEqual([undefined, undefined, undefined, "plain words"])
  expect(readFileSync(file, "utf8")).not.toContain(key)
})

test("a wallet's private key, a recovery phrase or one of the Candle Harness's own tokens keeps no text, and a file that was already there is narrowed", () => {
  const file = join(dir, "wallets.jsonl")
  writeFileSync(file, "", { mode: 0o644 })
  const log = pasteLogger({ CANDLE_HARNESS_PASTE_LOG: file })!
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const pair = Buffer.concat([privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32), publicKey.export({ format: "der", type: "spki" }).subarray(-32)])
  // Twelve words of the list whose checksum holds: all-zero entropy.
  const phrase = `${"abandon ".repeat(11)}about`
  const secrets = [pair.toString("hex"), JSON.stringify([...pair]), `restore ${phrase}`, `chv_${"a".repeat(43)}`, `cht_${"b".repeat(12)}_${"c".repeat(43)}`]
  for (const secret of secrets) log(secret)
  log("plain words")
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(rows.map((r) => r.text)).toEqual([undefined, undefined, undefined, undefined, undefined, "plain words"])
  expect(rows.map((r) => r.length)).toEqual([...secrets.map((s) => s.length), 11])
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test("a key named just before it keeps no text; so does a report with a bare 32-byte hash, which no shape tells from a key", () => {
  const file = join(dir, "named.jsonl")
  const log = pasteLogger({ CANDLE_HARNESS_PASTE_LOG: file })!
  const tx = "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060"
  const report = `someone asked for my private key, then ${tx} drained my wallet`
  log(`my private key is 0X${randomBytes(32).toString("hex")}`)
  log(report)
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(rows.map((r) => r.text)).toEqual([undefined, undefined])
})

test("the App hands a bracketed 4 KB paste over whole, and puts it on the input line", async () => {
  const got: string[] = []
  const { setup } = await drawScene("followed", 140, 40, "trade", undefined, { onPaste: (t) => got.push(t) })
  await act(async () => setup.mockInput.pasteBracketedText(LINE))
  await setup.renderOnce()
  expect(got).toEqual([LINE])
  expect(setup.captureCharFrame()).toContain(LINE.slice(-40))
  setup.renderer.destroy()
})

test("the check's diff names each stretch dropped, and anything added", () => {
  expect(LINE).toHaveLength(4096)
  expect(gaps(LINE, LINE)).toEqual([])
  const dropped = LINE.slice(0, 1000) + LINE.slice(1030, 3000) + LINE.slice(3048)
  expect(gaps(LINE, dropped)).toEqual([{ at: 1000, missing: 30 }, { at: 3000, missing: 48 }])
  expect(gaps(LINE, LINE.slice(0, 4000))).toEqual([{ at: 4000, missing: 96 }])
  expect(gaps(LINE, `${LINE}xy`)).toEqual([{ at: 4096, missing: -2 }])
})
