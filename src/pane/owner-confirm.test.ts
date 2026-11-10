import { describe, expect, test } from "bun:test"
import { parsePendingLine, pendingWords, StderrRelay } from "./owner-confirm"

const URL_OK = "https://candle.tv/dev/agent/confirm?code=WDJB-MJHT"
const line = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: false, pending: true, code: "OWNER_CONFIRM_REQUIRED", ownerConfirm: { userCode: "WDJB-MJHT", verificationUriComplete: URL_OK, expiresIn: 300, step: "keys.create", summary: "Create an API key labelled scout with write access", ...over }, ...top })

function relayed(chunks: string[]): string {
  let out = ""
  const relay = new StderrRelay((t) => void (out += t))
  for (const c of chunks) relay.push(c)
  relay.end()
  return out
}

describe("the pending line", () => {
  test("read into the summary, link, code and minutes, never the confirm id", () => {
    const p = parsePendingLine(line({ confirmId: "secret-confirm-id" }))
    expect(p).toEqual({ userCode: "WDJB-MJHT", url: URL_OK, expiresIn: 300, summary: "Create an API key labelled scout with write access" })
    const words = pendingWords(p!)
    expect(words).toBe(
      "This needs your approval in the browser: Create an API key labelled scout with write access\n" +
        `Open ${URL_OK}\nCode: WDJB-MJHT\nOnly approve if you just ran this command.\nWaiting for approval (expires in 5 minutes)...\n`,
    )
    expect(words).not.toContain("secret-confirm-id")
  })

  test("anything else is not the pending line: another code, no pending, a bad code, a link that isn't https", () => {
    expect(parsePendingLine(line({}, { code: "FORBIDDEN" }))).toBeUndefined()
    expect(parsePendingLine(line({}, { pending: false }))).toBeUndefined()
    expect(parsePendingLine(line({ userCode: "wdjb mjht\u001b[2J" }))).toBeUndefined()
    expect(parsePendingLine(line({ verificationUriComplete: "javascript:alert(1)" }))).toBeUndefined()
    expect(parsePendingLine(line({ verificationUriComplete: "http://candle.tv/dev/agent/confirm" }))).toBeUndefined()
    expect(parsePendingLine("{not json")).toBeUndefined()
    expect(parsePendingLine(JSON.stringify({ ok: true, key: "x" }))).toBeUndefined()
  })

  test("a summary is cleaned of terminal controls; a missing expiry reads as five minutes", () => {
    const p = parsePendingLine(line({ summary: "Rebind\u001b]0;owned\u0007 two wallets", expiresIn: undefined }))!
    expect(p.summary).not.toContain("\u001b")
    expect(p.expiresIn).toBe(300)
    expect(pendingWords({ ...p, expiresIn: 60 })).toContain("expires in 1 minute)")
  })
})

describe("the pane's stderr relay", () => {
  test("the pending line is said in words; the lines around it pass as they are", () => {
    const out = relayed([`Deriving the vault key\n${line()}\nApproved.\n`])
    expect(out).toContain("Deriving the vault key\n")
    expect(out).toContain("Code: WDJB-MJHT\n")
    expect(out).toContain("Approved.\n")
    expect(out).not.toContain('"pending"')
  })

  test("a pending line split across chunks is still said in words", () => {
    const whole = `${line()}\n`
    const out = relayed([whole.slice(0, 17), whole.slice(17, 90), whole.slice(90)])
    expect(out).toContain(`Open ${URL_OK}\n`)
    expect(out).not.toContain("{")
  })

  test("a prompt with no newline goes at once, so the person sees it while the CLI waits", () => {
    let out = ""
    const relay = new StderrRelay((t) => void (out += t))
    relay.push("Vault passphrase: ")
    expect(out).toBe("Vault passphrase: ")
    relay.push("\n")
    expect(out).toBe("Vault passphrase: \n")
  })

  test("a brace in the middle of a line isn't held; other JSON lines pass as they are", () => {
    let out = ""
    const relay = new StderrRelay((t) => void (out += t))
    relay.push("note: {")
    expect(out).toBe("note: {")
    relay.push('"x"}\n{"ok":false,"code":"FORBIDDEN"}\n')
    expect(out).toBe('note: {"x"}\n{"ok":false,"code":"FORBIDDEN"}\n')
  })

  test("what's held when the command ends goes as it is", () => {
    expect(relayed(['{"partial'])).toBe('{"partial')
  })
})
