// The prompt pane's tickets. Approving a card that runs in the pane runs nothing
// in the core: it mints a ticket, which the approving view hands to the launcher it starts in its own
// terminal pane (`candle-harness cli-pane`, in CANDLE_HARNESS_PANE_TICKET, never on a command line). The
// launcher says hello with it and redeems it once, for exactly what the card showed.
//
// A ticket is `chp_<ticketId>_<secret>`. The id is public: it names the ticket in the journal and in
// `pane.spawned`. The secret is 32 random bytes, and the book keeps only the whole ticket's SHA-256.
// A ticket:
//   - lives 120 s, and runs once;
//   - is redeemed only by the process the approving view started: the view names its pid
//     (`pane.spawned`), and the hello's peer pid must be that pid (shared/peer-pid.ts);
//   - is bound to the card's hash, which the core checks again at redeem.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { refused } from "../shared/rpc"
import type { EngineId } from "../engine/engine"
import type { PaneStep } from "./pane-plan"

export const TICKET_PREFIX = "chp_"
export const TICKET_TTL_MS = 120_000
/** How long a hello waits for the view's `pane.spawned`, which can arrive just after the launcher connects. */
export const PID_WAIT_MS = 3_000

/** What a redeemed ticket gives the launcher, besides the agent's key (added by the core at redeem). */
export interface PaneGrant {
  cardId: string
  opId: string
  /** The pane's title: `candle <command> · the agent can't see this pane`. */
  title: string
  /** The CLI to run: config's `candle.cliPath`. */
  bin: string
  steps: PaneStep[]
  identity: "agent" | "owner"
  agent?: string
  askPaths?: { flag: string; prompt: string }[]
  capture?: "code" | "addresses" | "new-key"
  /** A funds-out row: a stopped one may still land, and says so. */
  fundsOut?: boolean
  /** `keys create`: the agent the launcher stores the new key as. */
  newAgent?: string
  /** Onboarding's harness sign-in: no card; the fixed command for this engine, as the person. */
  harness?: EngineId
}

export interface TicketEntry {
  ticketId: string
  hash: string
  cardId: string
  cardHash: string
  viewClientId: string
  grant: PaneGrant
  mintedAt: number
  pid?: number
  redeemedAt?: number
}

const TICKET = /^chp_([A-Za-z0-9]{12})_[A-Za-z0-9_-]{43}$/
const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && timingSafeEqual(left, right)
}

function freshId(): string {
  for (;;) {
    const id = randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, 12)
    if (id.length === 12) return id
  }
}

export class PaneTickets {
  private readonly entries = new Map<string, TicketEntry>()
  private readonly pidWaiters = new Map<string, (() => void)[]>()
  private sweep: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly deps: {
      now: () => number
      /** A ticket nobody redeemed in time: nothing ran. */
      onExpired?: (entry: TicketEntry) => void
      ttlMs?: number
      pidWaitMs?: number
    },
  ) {}

  start(): void {
    this.sweep = setInterval(() => this.expireDue(), 1000)
    this.sweep.unref?.()
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep)
  }

  /** A new ticket for an approved card. The returned `ticket` exists nowhere else: the book keeps its hash. */
  mint(input: { cardId: string; cardHash: string; viewClientId: string; grant: PaneGrant }): { ticket: string; ticketId: string } {
    const ticketId = freshId()
    const ticket = `${TICKET_PREFIX}${ticketId}_${randomBytes(32).toString("base64url")}`
    this.entries.set(ticketId, { ticketId, hash: sha256Hex(ticket), cardId: input.cardId, cardHash: input.cardHash, viewClientId: input.viewClientId, grant: input.grant, mintedAt: this.deps.now() })
    return { ticket, ticketId }
  }

  /** The approving view names the pid of the pane process it started. Once, and only that view. */
  spawned(ticketId: unknown, viewClientId: string, pid: unknown): void {
    const entry = typeof ticketId === "string" ? this.entries.get(ticketId) : undefined
    // Another view's ticket answers as missing: a view learns nothing of a ticket it didn't approve.
    if (!entry || entry.viewClientId !== viewClientId || this.expired(entry)) throw refused("TICKET_NOT_FOUND", "No open ticket with that id.")
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) throw refused("BAD_PID", "pid must be the pane process's pid.")
    if (entry.pid !== undefined) throw refused("PANE_ALREADY_SPAWNED", "This ticket's pane process was already named.")
    entry.pid = pid
    for (const wake of this.pidWaiters.get(entry.ticketId) ?? []) wake()
    this.pidWaiters.delete(entry.ticketId)
  }

  /**
   * A hello with a ticket: the entry when the ticket is live, unredeemed, and `peer` is the pid the
   * view named. Waits briefly for that pid, since the launcher may connect before the view says it.
   */
  async authenticate(ticket: unknown, peer: number | undefined): Promise<TicketEntry | undefined> {
    if (typeof ticket !== "string") return undefined
    const match = TICKET.exec(ticket)
    const entry = match ? this.entries.get(match[1]!) : undefined
    if (!entry || !sameHex(sha256Hex(ticket), entry.hash) || entry.redeemedAt !== undefined || this.expired(entry)) return undefined
    if (entry.pid === undefined) await this.waitForPid(entry.ticketId)
    if (entry.pid === undefined || peer === undefined || peer !== entry.pid) return undefined
    return entry
  }

  /** Spends the ticket. A second redeem, or one after it expired, is refused. */
  redeem(ticketId: string): TicketEntry {
    const entry = this.entries.get(ticketId)
    if (!entry || entry.redeemedAt !== undefined) throw refused("TICKET_SPENT", "This ticket was already used.")
    if (this.expired(entry)) throw refused("TICKET_EXPIRED", "This ticket expired before it was used. Nothing ran.")
    entry.redeemedAt = this.deps.now()
    return entry
  }

  get(ticketId: string): TicketEntry | undefined {
    return this.entries.get(ticketId)
  }

  /** Tickets nobody redeemed in time are dropped, and their cards told nothing ran. Redeemed ones go after the same time. */
  expireDue(): void {
    for (const entry of [...this.entries.values()]) {
      if (!this.expired(entry)) continue
      this.entries.delete(entry.ticketId)
      if (entry.redeemedAt === undefined) this.deps.onExpired?.(entry)
    }
  }

  private expired(entry: TicketEntry): boolean {
    return this.deps.now() - entry.mintedAt >= (this.deps.ttlMs ?? TICKET_TTL_MS)
  }

  private waitForPid(ticketId: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.deps.pidWaitMs ?? PID_WAIT_MS)
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      this.pidWaiters.set(ticketId, [...(this.pidWaiters.get(ticketId) ?? []), wake])
    })
  }
}
