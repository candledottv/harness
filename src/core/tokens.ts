// Who may attach, and as what. The role is a property of the token, never
// something a client claims.
//
//   - `view`: one random token at a time. The core writes the current one to `state/view.token`
//     (0600, in the 0700 state folder) and rotates it on every view hello, so a view started while
//     the core runs reads it once and a replayed old token is refused. This protects against
//     cooperative agents, not hostile local code: engines' reads are held to their
//     research folder, and the shell is off by default.
//   - `harness`: minted per engine turn, bound to that turn's agent, kept by the core only as a
//     SHA-256 hash in `tokens.json` (0600), and revoked when the turn ends.
//
// A harness token is `cht_<tokenId>_<secret>`. The id is public (it names the token in the journal);
// the secret is 32 random bytes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { terminalText } from "../shared/terminal-text"

/** `pane`: the prompt pane's launcher, by a single-use ticket (tickets.ts), never by a token here. */
export type Role = "view" | "harness" | "pane"

export interface HarnessTokenRecord {
  tokenId: string
  name: string
  agent: string
  /** Lowercase hex SHA-256 of the whole token. */
  hash: string
  createdAt: string
}

export type Authenticated = { role: "view" } | { role: "harness"; tokenId: string; name: string; agent: string }

const HARNESS_PREFIX = "cht_"
const TOKEN_ID = /^[A-Za-z0-9]{12}$/

const b64u = (bytes: Buffer) => bytes.toString("base64url")
const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && timingSafeEqual(left, right)
}

function freshTokenId(): string {
  for (;;) {
    const id = b64u(randomBytes(16)).replace(/[-_]/g, "").slice(0, 12)
    if (TOKEN_ID.test(id)) return id
  }
}

/** A client or harness name as the Candle Harness will draw it: control characters stripped, 1 to 64 characters. */
export function cleanName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined
  const clean = terminalText(name).trim()
  return clean.length >= 1 && clean.length <= 64 ? clean : undefined
}

export class TokenBook {
  private viewToken = `chv_${b64u(randomBytes(32))}`
  /** Told of each view token this core issues, and the one it replaced, so the redactor holds only the live one. */
  private readonly onViewToken: ((token: string, previous?: string) => void)[] = []

  private constructor(
    private readonly paths: { tokens: string; viewToken: string },
    private records: HarnessTokenRecord[],
    private readonly now: () => number,
  ) {}

  private writes: Promise<void> = Promise.resolve()

  /** Opens the book. Harness tokens don't outlive their turn, so any left over from a past core are dropped. */
  static async open(paths: { tokens: string; viewToken: string }, now: () => number): Promise<TokenBook> {
    const book = new TokenBook(paths, [], now)
    await book.persist([])
    return book
  }

  /** Called with each new view token (the first one included) and the token it replaced, for the redactor. */
  onRotate(listener: (token: string, previous?: string) => void): void {
    this.onViewToken.push(listener)
    listener(this.viewToken)
  }

  /** Writes the current view token to `view.token` (0600), atomically. */
  async publishViewToken(): Promise<void> {
    const temp = `${this.paths.viewToken}.tmp-${b64u(randomBytes(6))}`
    await writeFile(temp, `${this.viewToken}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.paths.viewToken)
  }

  /** A fresh view token, written out at once. The old one is refused from now on. */
  async rotateViewToken(): Promise<void> {
    const previous = this.viewToken
    this.viewToken = `chv_${b64u(randomBytes(32))}`
    for (const listener of this.onViewToken) listener(this.viewToken, previous)
    await this.publishViewToken()
  }

  authenticate(token: unknown): Authenticated | undefined {
    if (typeof token !== "string" || token.length === 0 || token.length > 256) return undefined
    if (token.startsWith("chv_")) return sameHex(sha256Hex(token), sha256Hex(this.viewToken)) ? { role: "view" } : undefined
    if (!token.startsWith(HARNESS_PREFIX)) return undefined
    const tokenId = token.slice(HARNESS_PREFIX.length, HARNESS_PREFIX.length + 12)
    const record = this.records.find((r) => r.tokenId === tokenId)
    if (record === undefined || !sameHex(sha256Hex(token), record.hash)) return undefined
    return { role: "harness", tokenId: record.tokenId, name: record.name, agent: record.agent }
  }

  /** Mints a harness token for one turn of one agent. The returned `token` exists nowhere else: the book keeps its hash. */
  async mintHarness(name: string, agent: string): Promise<{ token: string; tokenId: string }> {
    const tokenId = freshTokenId()
    const token = `${HARNESS_PREFIX}${tokenId}_${b64u(randomBytes(32))}`
    try {
      await this.change([...this.records, { tokenId, name, agent, hash: sha256Hex(token), createdAt: new Date(this.now()).toISOString() }])
    } catch (error) {
      this.records = this.records.filter((r) => r.tokenId !== tokenId)
      throw error
    }
    return { token, tokenId }
  }

  /** Revokes a harness token. False for an id that's unknown or already revoked. */
  async revoke(tokenId: string): Promise<boolean> {
    if (!this.records.some((r) => r.tokenId === tokenId)) return false
    await this.change(this.records.filter((r) => r.tokenId !== tokenId))
    return true
  }

  harnessCount(): number {
    return this.records.length
  }

  /**
   * Turns end and start at the same moment (the kill switch cancels every agent's turn together),
   * so the change is made in memory before anything is awaited: a revoked token is refused at once,
   * and no change can be built on a list another change has since replaced. The writes then go out
   * one after another, each a snapshot, so the file ends on the latest list.
   */
  private change(records: HarnessTokenRecord[]): Promise<void> {
    this.records = records
    const write = this.writes.then(() => this.persist(records))
    this.writes = write.catch(() => {})
    return write
  }

  private async persist(records: HarnessTokenRecord[]): Promise<void> {
    const temp = `${this.paths.tokens}.tmp-${b64u(randomBytes(6))}`
    await writeFile(temp, `${JSON.stringify({ version: 2, harness: records }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.paths.tokens)
  }
}

/** Reads the current view token a running core published, for a view attaching to it. */
export async function readViewToken(path: string): Promise<string | undefined> {
  try {
    const token = (await readFile(path, "utf8")).trim()
    return token.startsWith("chv_") ? token : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
