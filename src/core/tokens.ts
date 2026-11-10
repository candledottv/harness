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
//   - `bot`: a code bot's, bound to the bot and its agent, kept as a hash in `tokens.json` and kept across
//     restarts, since the bot outlives a core. Issuing one for a bot replaces the one before; removing the bot
//     revokes it. A paper test's token is kept in memory only, never in the file: a test doesn't outlive its core.
//     A record whose bot is no longer saved is dropped at start.
//   - `build`: a Build pane's, bound to the agent the person builds for, kept as a hash, revoked when the
//     pane closes. Like a harness token, it doesn't outlive the core that minted it.
//
// A harness token is `cht_<tokenId>_<secret>`, a bot's `chb_<tokenId>_<secret>` and a build session's
// `chd_<tokenId>_<secret>`. The id is public (it names the token in the journal); the secret is 32 random bytes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { isTestName } from "../shared/bot-name"
import { terminalText } from "../shared/terminal-text"

/** `pane`: the prompt pane's launcher, by a single-use ticket (tickets.ts), never by a token here. */
export type Role = "view" | "harness" | "pane" | "bot" | "build"

export interface HarnessTokenRecord {
  tokenId: string
  name: string
  agent: string
  /** Lowercase hex SHA-256 of the whole token. */
  hash: string
  createdAt: string
}

export interface BotTokenRecord {
  tokenId: string
  /** The code bot's name. */
  bot: string
  agent: string
  hash: string
  createdAt: string
}

export interface BuildTokenRecord {
  tokenId: string
  name: string
  agent: string
  hash: string
  createdAt: string
}

export type Authenticated =
  | { role: "view" }
  | { role: "harness"; tokenId: string; name: string; agent: string }
  | { role: "bot"; tokenId: string; bot: string; agent: string }
  | { role: "build"; tokenId: string; name: string; agent: string }

const HARNESS_PREFIX = "cht_"
const BOT_PREFIX = "chb_"
const BUILD_PREFIX = "chd_"
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

  private bots: BotTokenRecord[] = []
  private builds: BuildTokenRecord[] = []

  private constructor(
    private readonly paths: { tokens: string; viewToken: string },
    private records: HarnessTokenRecord[],
    private readonly now: () => number,
  ) {}

  private writes: Promise<void> = Promise.resolve()

  /**
   * Opens the book. Harness and build tokens don't outlive their turn or pane, so any left over from a past core
   * are dropped; code bots' tokens are kept, since a bot run outside the Candle Harness connects again with its own.
   */
  static async open(paths: { tokens: string; viewToken: string }, now: () => number): Promise<TokenBook> {
    const book = new TokenBook(paths, [], now)
    book.bots = (await readBotRecords(paths.tokens)).filter((r) => !isTestName(r.bot))
    await book.persist({ harness: [], bot: book.bots, build: [] })
    return book
  }

  /** Called with each new view token (the first one included) and the token it replaced, for the redactor. */
  onRotate(listener: (token: string, previous?: string) => void): void {
    this.onViewToken.push(listener)
    listener(this.viewToken)
  }

  /** Writes a view token to `view.token` (0600), atomically: the current one unless another is given. */
  async publishViewToken(token: string = this.viewToken): Promise<void> {
    const temp = `${this.paths.viewToken}.tmp-${b64u(randomBytes(6))}`
    try {
      await writeFile(temp, `${token}\n`, { mode: 0o600, flag: "wx" })
      await chmod(temp, 0o600)
      await rename(temp, this.paths.viewToken)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  private rotation: Promise<void> = Promise.resolve()
  /** A hello has taken the current view token and its replacement isn't written yet: no second hello may use it. */
  private taken = 0

  /**
   * A fresh view token: written to the file first, and only once it's there does the core switch to it and
   * refuse the old one. If the write fails the old token stands, so the file and the core never disagree, and
   * the next attach works. One rotation at a time; while one runs, the token it's replacing is refused, so it
   * stays single-use across hellos that arrive together.
   */
  rotateViewToken(): Promise<void> {
    this.taken += 1
    const run = this.rotation.then(async () => {
      const next = `chv_${b64u(randomBytes(32))}`
      try {
        await this.publishViewToken(next)
      } finally {
        this.taken -= 1
      }
      const previous = this.viewToken
      this.viewToken = next
      for (const listener of this.onViewToken) listener(next, previous)
    })
    this.rotation = run.catch(() => {})
    return run
  }

  authenticate(token: unknown): Authenticated | undefined {
    if (typeof token !== "string" || token.length === 0 || token.length > 256) return undefined
    if (token.startsWith("chv_")) return this.taken === 0 && sameHex(sha256Hex(token), sha256Hex(this.viewToken)) ? { role: "view" } : undefined
    const idOf = (prefix: string) => token.slice(prefix.length, prefix.length + 12)
    const matches = (r: { tokenId: string; hash: string } | undefined) => r !== undefined && sameHex(sha256Hex(token), r.hash)
    if (token.startsWith(BOT_PREFIX)) {
      const r = this.bots.find((b) => b.tokenId === idOf(BOT_PREFIX))
      return matches(r) ? { role: "bot", tokenId: r!.tokenId, bot: r!.bot, agent: r!.agent } : undefined
    }
    if (token.startsWith(BUILD_PREFIX)) {
      const r = this.builds.find((b) => b.tokenId === idOf(BUILD_PREFIX))
      return matches(r) ? { role: "build", tokenId: r!.tokenId, name: r!.name, agent: r!.agent } : undefined
    }
    if (!token.startsWith(HARNESS_PREFIX)) return undefined
    const record = this.records.find((r) => r.tokenId === idOf(HARNESS_PREFIX))
    if (!matches(record)) return undefined
    return { role: "harness", tokenId: record!.tokenId, name: record!.name, agent: record!.agent }
  }

  /**
   * Mints a code bot's token, replacing any it had: the old one is refused from now on. The returned `token`
   * exists nowhere else.
   */
  async mintBot(bot: string, agent: string): Promise<{ token: string; tokenId: string; createdAt: string }> {
    const tokenId = this.freshId()
    const token = `${BOT_PREFIX}${tokenId}_${b64u(randomBytes(32))}`
    const createdAt = new Date(this.now()).toISOString()
    const before = this.bots
    try {
      await this.change({ bot: [...this.bots.filter((b) => b.bot !== bot), { tokenId, bot, agent, hash: sha256Hex(token), createdAt }] })
    } catch (error) {
      this.bots = before
      throw error
    }
    return { token, tokenId, createdAt }
  }

  /** Revokes a code bot's token: its id, or undefined when it had none. */
  async revokeBot(bot: string): Promise<string | undefined> {
    const had = this.bots.find((b) => b.bot === bot)
    if (!had) return undefined
    await this.change({ bot: this.bots.filter((b) => b.bot !== bot) })
    return had.tokenId
  }

  /**
   * Drops every code bot's token whose bot isn't saved now: a bot removed while the file couldn't be written, or
   * from a bots.toml edited by hand, leaves nothing that could say hello under its name again.
   */
  async pruneBots(saved: ReadonlySet<string>): Promise<string[]> {
    const gone = this.bots.filter((b) => !isTestName(b.bot) && !saved.has(b.bot))
    if (gone.length) await this.change({ bot: this.bots.filter((b) => !gone.includes(b)) })
    return gone.map((b) => b.bot)
  }

  /** A code bot's token, by its id and when it was issued; never its hash. */
  botToken(bot: string): { tokenId: string; createdAt: string } | undefined {
    const r = this.bots.find((b) => b.bot === bot)
    return r ? { tokenId: r.tokenId, createdAt: r.createdAt } : undefined
  }

  /** Mints a Build pane's token, bound to the agent the person builds for. */
  async mintBuild(name: string, agent: string): Promise<{ token: string; tokenId: string }> {
    const tokenId = this.freshId()
    const token = `${BUILD_PREFIX}${tokenId}_${b64u(randomBytes(32))}`
    const before = this.builds
    try {
      await this.change({ build: [...this.builds, { tokenId, name, agent, hash: sha256Hex(token), createdAt: new Date(this.now()).toISOString() }] })
    } catch (error) {
      this.builds = before
      throw error
    }
    return { token, tokenId }
  }

  /** A token id no live token of any kind holds. */
  private freshId(): string {
    for (;;) {
      const id = freshTokenId()
      if (!this.records.some((r) => r.tokenId === id) && !this.bots.some((r) => r.tokenId === id) && !this.builds.some((r) => r.tokenId === id)) return id
    }
  }

  /** Mints a harness token for one turn of one agent. The returned `token` exists nowhere else: the book keeps its hash. */
  async mintHarness(name: string, agent: string): Promise<{ token: string; tokenId: string }> {
    const tokenId = this.freshId()
    const token = `${HARNESS_PREFIX}${tokenId}_${b64u(randomBytes(32))}`
    try {
      await this.change({ harness: [...this.records, { tokenId, name, agent, hash: sha256Hex(token), createdAt: new Date(this.now()).toISOString() }] })
    } catch (error) {
      this.records = this.records.filter((r) => r.tokenId !== tokenId)
      throw error
    }
    return { token, tokenId }
  }

  /** Revokes a harness or build token. False for an id that's unknown or already revoked. */
  async revoke(tokenId: string): Promise<boolean> {
    if (this.builds.some((r) => r.tokenId === tokenId)) {
      await this.change({ build: this.builds.filter((r) => r.tokenId !== tokenId) })
      return true
    }
    if (!this.records.some((r) => r.tokenId === tokenId)) return false
    await this.change({ harness: this.records.filter((r) => r.tokenId !== tokenId) })
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
  private change(next: { harness?: HarnessTokenRecord[]; bot?: BotTokenRecord[]; build?: BuildTokenRecord[] }): Promise<void> {
    if (next.harness) this.records = next.harness
    if (next.bot) this.bots = next.bot
    if (next.build) this.builds = next.build
    const snapshot = { harness: this.records, bot: this.bots, build: this.builds }
    const write = this.writes.then(() => this.persist(snapshot))
    this.writes = write.catch(() => {})
    return write
  }

  private async persist(all: { harness: HarnessTokenRecord[]; bot: BotTokenRecord[]; build: BuildTokenRecord[] }): Promise<void> {
    const temp = `${this.paths.tokens}.tmp-${b64u(randomBytes(6))}`
    // A paper test's token lives in memory alone.
    const kept = { ...all, bot: all.bot.filter((r) => !isTestName(r.bot)) }
    await writeFile(temp, `${JSON.stringify({ version: 3, ...kept }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.paths.tokens)
  }
}

/** The code bots' tokens a past core kept: each whole, or left out. */
async function readBotRecords(path: string): Promise<BotTokenRecord[]> {
  try {
    const saved = JSON.parse(await readFile(path, "utf8")) as { bot?: unknown }
    if (!Array.isArray(saved.bot)) return []
    return saved.bot.filter(
      (r): r is BotTokenRecord =>
        typeof r === "object" && r !== null && TOKEN_ID.test(String((r as BotTokenRecord).tokenId)) && typeof (r as BotTokenRecord).bot === "string" && typeof (r as BotTokenRecord).agent === "string" && /^[0-9a-f]{64}$/.test(String((r as BotTokenRecord).hash)) && typeof (r as BotTokenRecord).createdAt === "string",
    )
  } catch {
    return []
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
