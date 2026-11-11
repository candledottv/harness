// Candle's browser confirm for owner steps, as the prompt pane shows it. Where Candle's API asks for it,
// an owner step made with the CLI's device token answers 403 OWNER_CONFIRM_REQUIRED; the CLI (0.13.20 on)
// then shows a summary, a link and a code, waits while the owner approves in the browser, and sends the
// same request again. Its words go to stderr. Under --json, which the pane passes only for a row whose
// answer it reads, they are one JSON line instead:
//   {"ok":false,"pending":true,"code":"OWNER_CONFIRM_REQUIRED","ownerConfirm":{userCode,verificationUriComplete,expiresIn,step,summary}}
// so the pane relays that row's stderr and puts the line back into the CLI's own words. Everything else
// on stderr, prompts included, passes through as it comes.
import { terminalText } from "../shared/terminal-text"

/**
 * What the person needs from a pending confirm: never its secret id, which the CLI keeps to itself. `withheld` names the
 * host of a link that isn't Candle's, which isn't shown; `url` is then empty.
 */
export interface OwnerConfirmPending {
  userCode: string
  url: string
  expiresIn: number
  summary: string
  withheld?: string
}

const USER_CODE = /^[A-Z0-9]{2,12}(-[A-Z0-9]{2,12}){0,3}$/

/** Candle's site, where its confirm page is: the site itself or one of its own subdomains. */
const candleHost = (host: string) => host === "candle.tv" || host.endsWith(".candle.tv")

/**
 * A link the pane may show: https on Candle's site, or http on this machine (a developer's own Candle). Any other is
 * withheld, by its host where it has one: the page asks for the account owner's approval, and a link elsewhere could
 * collect it for someone else.
 */
function confirmUrl(value: unknown): { url: string } | { withheld: string } {
  const elsewhere = { withheld: "an address that isn't a web page" }
  if (typeof value !== "string" || value.length > 600 || /[\x00-\x20\x7f]/.test(value)) return elsewhere
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return elsewhere
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return elsewhere
  const host = terminalText(url.hostname, { maxLength: 80 })
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol === "https:" ? candleHost(url.hostname) || local : local) return { url: url.toString() }
  return { withheld: host }
}

/** The pending line's fields, or undefined for any other line. */
export function parsePendingLine(line: string): OwnerConfirmPending | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  const body = parsed as { pending?: unknown; code?: unknown; ownerConfirm?: Record<string, unknown> } | null
  if (!body || body.pending !== true || body.code !== "OWNER_CONFIRM_REQUIRED" || typeof body.ownerConfirm !== "object" || body.ownerConfirm === null) return undefined
  const oc = body.ownerConfirm
  const userCode = typeof oc.userCode === "string" && USER_CODE.test(oc.userCode) ? oc.userCode : undefined
  if (!userCode) return undefined
  const link = confirmUrl(oc.verificationUriComplete)
  const expiresIn = typeof oc.expiresIn === "number" && Number.isFinite(oc.expiresIn) && oc.expiresIn > 0 ? oc.expiresIn : 300
  const summary = typeof oc.summary === "string" ? terminalText(oc.summary, { maxLength: 300 }) : ""
  return "url" in link ? { userCode, url: link.url, expiresIn, summary } : { userCode, url: "", expiresIn, summary, withheld: link.withheld }
}

/** The CLI's own words for a pending confirm, as it prints them without --json. */
export function pendingWords(p: OwnerConfirmPending): string {
  const minutes = Math.max(1, Math.round(p.expiresIn / 60))
  if (p.withheld !== undefined) {
    return [
      `This asks for your approval in the browser${p.summary ? `: ${p.summary}` : "."}`,
      `Its link isn't on Candle's site (${p.withheld}), so it isn't shown. Don't approve it: the step ends unapproved when its code expires (${minutes} minute${minutes === 1 ? "" : "s"}), and nothing changes.`,
    ].join("\n").concat("\n")
  }
  return [
    `This needs your approval in the browser${p.summary ? `: ${p.summary}` : "."}`,
    `Open ${p.url}`,
    `Code: ${p.userCode}`,
    "Only approve if you just ran this command.",
    `Waiting for approval (expires in ${minutes} minute${minutes === 1 ? "" : "s"})...`,
  ].join("\n").concat("\n")
}

/** Longest line held back while it might be the pending line; anything longer passes through as it is. */
const HOLD_LIMIT = 8192

/**
 * Relays a command's stderr to the pane. A line that starts with `{` is held until its newline, so the
 * pending line can be put in words; any other text, a prompt with no newline included, goes at once.
 */
export class StderrRelay {
  private held = ""
  private atLineStart = true

  constructor(private readonly write: (text: string) => void) {}

  push(chunk: string): void {
    let text = this.held + chunk
    this.held = ""
    for (;;) {
      const nl = text.indexOf("\n")
      if (nl === -1) break
      const line = text.slice(0, nl)
      text = text.slice(nl + 1)
      const pending = this.atLineStart ? parsePendingLine(line) : undefined
      this.write(pending ? pendingWords(pending) : `${line}\n`)
      this.atLineStart = true
    }
    if (text === "") return
    if (this.atLineStart && text.startsWith("{") && text.length <= HOLD_LIMIT) {
      this.held = text
      return
    }
    this.write(text)
    this.atLineStart = false
  }

  /** The command ended: whatever is held goes as it is. */
  end(): void {
    if (this.held) this.write(this.held)
    this.held = ""
    this.atLineStart = true
  }
}
