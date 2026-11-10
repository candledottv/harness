// The core's redactor; the journal half is in core/journal.test.ts.
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { REDACTED, Redactor, withoutFactorValue } from "./redact"

const READ_KEY = `cndl_test_${"r".repeat(43)}`
const DEVICE_TOKEN = "dt_example_device_token_value"

describe("Redactor", () => {
  test("removes every registered value wherever it appears", () => {
    const redactor = new Redactor()
    redactor.add(DEVICE_TOKEN)
    expect(redactor.text(`upstream said: bad token ${DEVICE_TOKEN} (retry)`)).toBe(
      `upstream said: bad token ${REDACTED} (retry)`,
    )
  })

  test("removes a Candle API key by shape even when it was never registered", () => {
    expect(new Redactor().text(`401 for ${READ_KEY}`)).toBe(`401 for ${REDACTED}`)
  })

  test("removes key-carrying URL parameters and Bearer tokens", () => {
    const redactor = new Redactor()
    expect(redactor.text("GET https://rpc.example/?api-key=abc123secret&cluster=main")).toBe(
      `GET https://rpc.example/?api-key=${REDACTED}&cluster=main`,
    )
    expect(redactor.text("https://x/y?foo=1&api_key=zzz")).toBe(`https://x/y?foo=1&api_key=${REDACTED}`)
    expect(redactor.text("Authorization: Bearer eyJhbGciOi.payload.sig")).toBe(`Authorization: Bearer ${REDACTED}`)
  })

  test("a longer registered secret that contains a shorter one is removed whole", () => {
    const redactor = new Redactor()
    redactor.add("abcdefgh")
    redactor.add("abcdefgh-ijklmnop")
    expect(redactor.text("x abcdefgh-ijklmnop y")).toBe(`x ${REDACTED} y`)
  })

  test("short and blank values are not registered, so ordinary text survives", () => {
    const redactor = new Redactor()
    redactor.add("abc")
    redactor.add("   ")
    redactor.add(undefined)
    expect(redactor.text("abc is fine")).toBe("abc is fine")
  })

  test("value() redacts deeply, replaces forbidden fields and strips a factor's value but not its type", () => {
    const redactor = new Redactor()
    redactor.add(DEVICE_TOKEN)
    const out: unknown = redactor.value({
      type: "cards.approve",
      factor: { type: "passphrase", value: "correct horse battery staple" },
      passphrase: "also never",
      nested: { list: [`token ${DEVICE_TOKEN}`, 3, null], ok: true },
    })
    expect(out).toEqual({
      type: "cards.approve",
      factor: { type: "passphrase" },
      passphrase: REDACTED,
      nested: { list: [`token ${REDACTED}`, 3, null], ok: true },
    })
    expect(JSON.stringify(out)).not.toContain("correct horse")
  })

  test("remove() forgets a value", () => {
    const redactor = new Redactor()
    redactor.add(DEVICE_TOKEN)
    redactor.remove(DEVICE_TOKEN)
    expect(redactor.text(DEVICE_TOKEN)).toBe(DEVICE_TOKEN)
  })

  test("a value added or removed after a redaction is honoured on the next one, longest still first", () => {
    const redactor = new Redactor()
    redactor.add("abcdefgh")
    expect(redactor.text("x abcdefgh-ijklmnop y")).toBe(`x ${REDACTED}-ijklmnop y`)
    redactor.add("abcdefgh-ijklmnop")
    expect(redactor.text("x abcdefgh-ijklmnop y")).toBe(`x ${REDACTED} y`)
    redactor.remove("abcdefgh-ijklmnop")
    redactor.add("abcdefgh")
    expect(redactor.size).toBe(1)
    expect(redactor.text("x abcdefgh-ijklmnop y")).toBe(`x ${REDACTED}-ijklmnop y`)
  })

  test("withoutFactorValue keeps everything but the value", () => {
    expect(withoutFactorValue({ type: "touch-id", value: "x", envelopeId: "e1" })).toEqual({
      type: "touch-id",
      envelopeId: "e1",
    })
    expect(withoutFactorValue(undefined)).toBeUndefined()
  })

  test("token and access_token URL parameters are redacted too", () => {
    const redactor = new Redactor()
    expect(redactor.text("wss://x/feed?token=abc123&access_token=def456")).toBe(
      `wss://x/feed?token=${REDACTED}&access_token=${REDACTED}`,
    )
  })

  test("a registered agent key is redacted inside a longer string and inside a field", () => {
    const key = `cndl_live_${"k".repeat(40)}`
    const redactor = new Redactor()
    redactor.add(key)
    expect(redactor.value({ args: ["mcp"], env: `CANDLE_API_KEY=${key}` })).toEqual({
      args: ["mcp"],
      env: `CANDLE_API_KEY=${REDACTED}`,
    })
  })
})

describe("other services' keys", () => {
  const redactor = new Redactor()
  // Built at run time, so no key-shaped literal sits in the source.
  const tail = (n: number) => "aB3dE5gH7j".repeat(Math.ceil(n / 10)).slice(0, n)
  const keys = {
    anthropic: `sk-ant-api03-${tail(90)}`,
    openai: `sk-proj-${tail(120)}`,
    openaiLegacy: `sk-${tail(48)}`,
    openrouter: `sk-or-v1-${tail(64)}`,
    xai: `xai-${tail(80)}`,
    github: `ghp_${tail(36)}`,
    githubFine: `github_pat_${tail(82)}`,
    gitlab: `glpat-${tail(20)}`,
    slack: `xoxb-${tail(40)}`,
    aws: `AKIA${"ABCDEFGH12345678"}`,
    google: `AIza${tail(35)}`,
    stripe: `sk_live_${tail(24)}`,
    huggingface: `hf_${tail(34)}`,
  }
  for (const [name, key] of Object.entries(keys)) {
    test(`${name}, in a sentence`, () => {
      expect(redactor.text(`my owner key is ${key}, use it`)).toBe(`my owner key is ${REDACTED}, use it`)
    })
  }
  test("a PEM private key, whole", () => {
    // Built at run time: the scrub refuses a key's header as a literal.
    const edge = (e: string) => `-----${e} ${["OPENSSH", "PRIVATE", "KEY"].join(" ")}-----`
    const pem = [edge("BEGIN"), tail(60), tail(60), edge("END")].join("\n")
    expect(redactor.text(`here:\n${pem}\nthanks`)).toBe(`here:\n${REDACTED}\nthanks`)
  })
  test("ordinary words with the same starts survive", () => {
    const text = "risk-adjusted desk-level ask-price sk-short xai-team ghp_x AKIA AIzaSmall hf_model"
    expect(redactor.text(text)).toBe(text)
  })
})

// What must never be redacted: the ids and addresses a trader reads to know what happened.
describe("no false positives", () => {
  const redactor = new Redactor()
  redactor.add(`cndl_live_${"k".repeat(40)}`)
  redactor.add(DEVICE_TOKEN)

  test("a mint address", () => {
    const text = "bought MOON at MoonFake11111111111111111111111111111111111 (mint 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU)"
    expect(redactor.text(text)).toBe(text)
  })

  test("a transaction signature", () => {
    const sig = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
    expect(redactor.text(`landed: ${sig}`)).toBe(`landed: ${sig}`)
    expect(redactor.text(`https://solscan.io/tx/${sig}?cluster=mainnet`)).toBe(`https://solscan.io/tx/${sig}?cluster=mainnet`)
  })

  test("a clientTradeId and the fields that carry ids", () => {
    const row = { clientTradeId: "0b5f7c2e-4d1a-4e8b-9f3a-2c6d8e1f4a7b", clientSwapId: "c1d2", opId: "op-1", keyPrefix: "cndl_li" }
    expect(redactor.value(row)).toEqual(row)
  })
})

describe("more secret shapes", () => {
  const redactor = new Redactor()

  test("refresh_token, password, client_secret, id_token and dkey URL parameters", () => {
    const text = "https://auth.example.com/cb?refresh_token=rt_abcdef123456&password=hunter22hunter&client_secret=cs_9a8b7c6d5e&id_token=abc.def.ghi&x=1 https://lb.drpc.org/ogrpc?network=solana&dkey=AbCdEf1234567890"
    const out = redactor.text(text)
    for (const secret of ["rt_abcdef123456", "hunter22hunter", "cs_9a8b7c6d5e", "abc.def.ghi", "AbCdEf1234567890"]) expect(out).not.toContain(secret)
    expect(out).toContain("x=1")
    expect(out).toContain("network=solana")
  })

  test("a URL's user:pass@, and a Basic credential, but not the word Basic in prose", () => {
    expect(redactor.text("postgres://admin:s3cr3tpass@db.internal:5432/app")).toBe(`postgres://${REDACTED}@db.internal:5432/app`)
    expect(redactor.text("https://ghp_token_as_user@github.com/x/y.git")).toBe(`https://${REDACTED}@github.com/x/y.git`)
    const basic = Buffer.from("alice:wonderland-pass").toString("base64")
    expect(redactor.text(`Authorization: Basic ${basic}`)).toBe(`Authorization: Basic ${REDACTED}`)
    expect(redactor.text("Basic information about the token")).toBe("Basic information about the token")
  })

  test("a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    expect(redactor.text(`token ${jwt} end`)).toBe(`token ${REDACTED} end`)
  })

  test("an RPC provider's key in its URL's path", () => {
    const out = redactor.text("rpc https://young-rough-pond.solana-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef/ and https://solana-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz012345")
    expect(out).toBe(`rpc https://young-rough-pond.solana-mainnet.quiknode.pro/${REDACTED}/ and https://solana-mainnet.g.alchemy.com/v2/${REDACTED}`)
  })

  test("a keypair file's 64-number array, and only a real keypair's", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const pair = [...privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32), ...publicKey.export({ format: "der", type: "spki" }).subarray(-32)]
    expect(redactor.text(`key: ${JSON.stringify(pair)}`)).toBe(`key: ${REDACTED}`)
    // 64 numbers that aren't a keypair (a signature's bytes, say) stay, as does a short list.
    const other = `[${Array.from({ length: 64 }, (_, i) => (i * 37) % 256).join(",")}]`
    expect(redactor.text(other)).toBe(other)
    expect(redactor.text("[1, 2, 3]")).toBe("[1, 2, 3]")
  })

  test("fields privateKey, mnemonic, secretKey and seed are never written", () => {
    const out = redactor.value({ privateKey: "abc", mnemonic: "word word word", secretKey: [1, 2, 3], seed: "xyz", private_key: "p", mint: "MoonFake11111111111111111111111111111111111" })
    expect(out as unknown).toEqual({ privateKey: REDACTED, mnemonic: REDACTED, secretKey: REDACTED, seed: REDACTED, private_key: REDACTED, mint: "MoonFake11111111111111111111111111111111111" })
  })

  test("a transaction signature on Solscan still shows", () => {
    const sig = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
    expect(redactor.text(`https://solscan.io/tx/${sig}`)).toBe(`https://solscan.io/tx/${sig}`)
  })
})
