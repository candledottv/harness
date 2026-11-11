// What every view shows the same: the pins, and the person's last pick,
// for the agent's next turn. The linked token itself is the token watch's followed one (token-watch.ts);
// the `views` topic (view-only) carries it with who moved it, and the pins.
//
// - A pin holds a token pane on its token while the link moves on. It's kept by where the pane is: a tab's
//   name, or `popped out` for a popped token pane, and which of the layout's token panes it is (up to three
//   side by side; the first unless named). At most three across every place, each watched at the link's
//   5 s; a fourth says which are pinned, to unpin one. Pins survive a restart (`state/pins.json`, 0600, as
//   the mode is).
// - The person's pick: a token picked in a pane since an agent's last turn is named once in that agent's
//   next turn, fenced as the Candle Harness's note. The agent showing a token isn't a pick.
// - Popped panes: a view started as `candle-harness view --pane <id>` says which pane it shows,
//   and it's held by that view's connection, so it comes back to the tiled views when the popped one
//   closes or dies (a pane moves, not copies). Each pane is popped once at a time.
// - Signals' choices: each place's Signals pane shows Hacc's tape or the account's own
//   rules' signals, and may filter by one pattern and one chain. Kept by place as pins are, so every view
//   of a tab shows the same, and they survive a restart (`state/signals-filters.json`, 0600).
// - The chain filter: one chain, or all of them, for every pane of every view (the agent's pane and its cards
//   aside), kept across a restart (`state/chain-filter.json`, 0600). All chains is kept as no choice, and every
//   account starts there: a Signals pane's own chain is a choice about the tape, not about the wallets.
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, rename, writeFile } from "node:fs/promises"
import { isTokenPane, type PaneId, type TokenPane } from "../shared/panes"
import { terminalText } from "../shared/terminal-text"
import { type ChainSlug, familyOfAddress, maybeChain, storedChain } from "../shared/chains"

export const MAX_PINS = 3
/** A place's name: a tab's, as layouts.toml allows (layouts-file.ts), or a popped pane's. */
const MAX_PLACE = 40

export type Chain = ChainSlug

export interface Pin {
  /** Where the pinned token pane is: a tab's name. */
  at: string
  /** Which of the place's token panes: absent, the first. */
  pane?: Exclude<TokenPane, "token">
  mint: string
  chain: Chain
  symbol?: string
}

/** A Signals pane's choice, by where it is: the person's own rules' signals or Hacc's tape, and its filters. Absent, the whole tape. */
export interface SignalsChoice {
  at: string
  mine?: true
  pattern?: string
  chain?: Chain
}

export interface ViewsTopic {
  link: { mint: string; chain: Chain; symbol?: string; since: number; by?: "you" | "agent" } | null
  pins: Pin[]
  /** Each place's Signals choice, where it isn't the whole tape. */
  signals: SignalsChoice[]
  /** The panes popped out into views of their own, which the tiled views leave out. */
  popped: PaneId[]
  /** The chain every pane shows, or null (or absent, from an older core) for all of them. */
  chain?: Chain | null
}

/** The person's pick, as the agent is told it. */
export interface Picked {
  mint: string
  chain: Chain
  symbol?: string
  name?: string
  at: number
}

const MINT = { test: (word: string) => familyOfAddress(word) !== undefined }

/** A mint as a view may send it, or undefined. */
export const mintParam = (value: unknown): string | undefined => (typeof value === "string" && MINT.test(value) ? value : undefined)
export const chainParam = (value: unknown): Chain | undefined => (value === undefined ? "solana" : maybeChain(value)?.slug)
/** Which token pane a pin is on. */
export const pinPane = (pin: Pick<Pin, "pane">): TokenPane => pin.pane ?? "token"
const samePlace = (a: Pick<Pin, "at" | "pane">, b: Pick<Pin, "at" | "pane">) => a.at === b.at && pinPane(a) === pinPane(b)
/** A token pane as a view may send it: absent, the first. */
export const tokenPaneParam = (value: unknown): TokenPane | undefined => (value === undefined ? "token" : isTokenPane(value) ? value : undefined)
/** A pin's place as it's kept: the first token pane isn't named, so a pins file from before still reads. */
const placed = (at: string, pane: TokenPane): Pick<Pin, "at" | "pane"> => (pane === "token" ? { at } : { at, pane })

/** A place's name as a view may send it: printable, at most 40 characters. */
export const placeParam = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_PLACE && terminalText(value, { maxLength: MAX_PLACE }) === value ? value : undefined

function readPins(path: string): Pin[] {
  try {
    const raw = (JSON.parse(readFileSync(path, "utf8")) as { pins?: unknown }).pins
    if (!Array.isArray(raw)) return []
    const out: Pin[] = []
    for (const p of raw) {
      const at = placeParam(p?.at)
      const pane = tokenPaneParam(p?.pane)
      const mint = mintParam(p?.mint)
      // A pin kept before pins carried their chain is on its mint's family's chain.
      const chain = p?.chain === undefined ? storedChain(undefined, mint) : chainParam(p.chain)
      if (!at || !pane || !mint || !chain || out.some((o) => samePlace(o, placed(at, pane)))) continue
      const symbol = typeof p?.symbol === "string" ? terminalText(p.symbol, { maxLength: 16 }) : undefined
      out.push({ ...placed(at, pane), mint, chain, ...(symbol ? { symbol } : {}) })
    }
    return out.slice(0, MAX_PINS)
  } catch {
    return []
  }
}

async function saveJson(path: string, data: Record<string, unknown>, now: number): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
  await writeFile(temp, `${JSON.stringify({ ...data, at: new Date(now).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
  await chmod(temp, 0o600)
  await rename(temp, path)
}
const savePins = (path: string, pins: readonly Pin[], now: number) => saveJson(path, { pins }, now)

/** A pattern's name as Hacc writes it (`large_move`), as a view may send it. */
export const patternParam = (value: unknown): string | undefined => (typeof value === "string" && /^[a-z0-9_]{1,40}$/.test(value) ? value : undefined)

/** A choice as a view may send it, or a problem; one that's the whole tape is `{at}` alone. */
export function signalsChoiceParam(params: Record<string, unknown>): SignalsChoice | { problem: string } {
  const at = placeParam(params.at)
  if (!at) return { problem: "at names the tab the Signals pane is on." }
  if (params.mine !== undefined && typeof params.mine !== "boolean") return { problem: "mine is true for your own rules' signals, false for Hacc's tape." }
  const pattern = params.pattern === undefined || params.pattern === null ? undefined : patternParam(params.pattern)
  if ((params.pattern ?? null) !== null && !pattern) return { problem: "pattern is one of Hacc's pattern names, such as large_move, or null for every pattern." }
  const chain = params.chain === undefined || params.chain === null ? undefined : params.chain === "solana" || params.chain === "hood" ? params.chain : null
  if (chain === null) return { problem: 'chain is "solana", "hood", or null for both.' }
  return { at, ...(params.mine === true ? { mine: true as const } : {}), ...(pattern ? { pattern } : {}), ...(chain ? { chain } : {}) }
}

/** A chain filter as a view may send it: a chain that's on, or null for all of them. */
export function chainFilterParam(value: unknown): { chain: Chain | null } | { problem: string } {
  if (value === null) return { chain: null }
  const chain = maybeChain(value)?.slug
  return chain ? { chain } : { problem: "chain is a chain that's on, such as \"solana\" or \"hood\", or null for all of them." }
}

function readChain(path: string | undefined): Chain | null {
  if (!path) return null
  try {
    const read = chainFilterParam((JSON.parse(readFileSync(path, "utf8")) as { chain?: unknown }).chain ?? null)
    return "problem" in read ? null : read.chain
  } catch {
    return null
  }
}

const isWholeTape = (c: SignalsChoice) => !c.mine && !c.pattern && !c.chain

function readChoices(path: string | undefined): SignalsChoice[] {
  if (!path) return []
  try {
    const raw = (JSON.parse(readFileSync(path, "utf8")) as { signals?: unknown }).signals
    if (!Array.isArray(raw)) return []
    const out: SignalsChoice[] = []
    for (const c of raw) {
      if (!c || typeof c !== "object") continue
      const read = signalsChoiceParam(c as Record<string, unknown>)
      if ("problem" in read || isWholeTape(read) || out.some((o) => o.at === read.at)) continue
      out.push(read)
    }
    return out
  } catch {
    return []
  }
}

/** Where a pin is, in words: "Trade", or "Trade's token:2" for another of its token panes. */
export const placeWords = (p: Pick<Pin, "at" | "pane">): string => (p.pane ? `${p.at}'s ${p.pane}` : p.at)

export class ViewState {
  private pinList: Pin[]
  private picked: Picked | undefined
  /** When each agent was last told of a pick: the pick's own time. */
  private readonly told = new Map<string, number>()
  /** Each popped pane, by the connection of the view that shows it. */
  private readonly poppedBy = new Map<PaneId, string>()

  private choiceList: SignalsChoice[]
  private chainFilter: Chain | null

  /** `signalsPath` and `chainPath`: where Signals' choices and the chain filter are kept; without them, they last as long as the core. */
  constructor(private readonly deps: { path: string; signalsPath?: string; chainPath?: string; now: () => number }) {
    this.pinList = readPins(deps.path)
    this.choiceList = readChoices(deps.signalsPath)
    this.chainFilter = readChain(deps.chainPath)
  }

  /** The chain every pane shows, or null for all of them. */
  chain(): Chain | null {
    return this.chainFilter
  }

  /** Every pane shows `chain` from now (null, all of them). True when it changed. */
  async setChain(chain: Chain | null): Promise<boolean> {
    if (chain === this.chainFilter) return false
    this.chainFilter = chain
    if (this.deps.chainPath) await saveJson(this.deps.chainPath, { chain }, this.deps.now())
    return true
  }

  signals(): SignalsChoice[] {
    return this.choiceList.map((c) => ({ ...c }))
  }

  /** The Signals pane at `choice.at` shows this from now; the whole tape is kept as no choice at all. True when it changed. */
  async setSignals(choice: SignalsChoice): Promise<boolean> {
    const was = this.choiceList.find((c) => c.at === choice.at)
    if (JSON.stringify(was ?? { at: choice.at }) === JSON.stringify(choice)) return false
    this.choiceList = [...this.choiceList.filter((c) => c.at !== choice.at), ...(isWholeTape(choice) ? [] : [{ ...choice }])]
    await this.saveChoices()
    return true
  }

  private async saveChoices(): Promise<void> {
    if (this.deps.signalsPath) await saveJson(this.deps.signalsPath, { signals: this.choiceList }, this.deps.now())
  }

  pins(): Pin[] {
    return this.pinList.map((p) => ({ ...p }))
  }

  /** Pins the token pane at `at` (its first, unless `pin.pane` names another) on a token; a fourth pin is refused, naming the three. */
  async pin(pin: Pin): Promise<{ ok: true } | { ok: false; message: string }> {
    const others = this.pinList.filter((p) => !samePlace(p, pin))
    if (others.length >= MAX_PINS) {
      const named = others.map((p) => `${placeWords(p)} on ${p.symbol ?? `${p.mint.slice(0, 4)}…`}`).join(", ")
      return { ok: false, message: `${MAX_PINS} token panes are pinned already (${named}): unpin one first.` }
    }
    this.pinList = [...others, { ...pin }]
    await savePins(this.deps.path, this.pinList, this.deps.now())
    return { ok: true }
  }

  /** The pin on the token pane at `at` (its first, unless `pane` names another) goes; with `pane` "all", every pin at `at`. True when there was one. */
  async unpin(at: string, pane: TokenPane | "all" = "token"): Promise<boolean> {
    const gone = (p: Pin) => p.at === at && (pane === "all" || pinPane(p) === pane)
    if (!this.pinList.some(gone)) return false
    this.pinList = this.pinList.filter((p) => !gone(p))
    await savePins(this.deps.path, this.pinList, this.deps.now())
    return true
  }

  /** A tab renamed: its pins and its Signals choice go with it. True when there was one to move. */
  async move(from: string, to: string): Promise<boolean> {
    if (from === to) return false
    const moving = this.pinList.filter((p) => p.at === from)
    const choice = this.choiceList.find((c) => c.at === from)
    if (moving.length) {
      this.pinList = [...this.pinList.filter((p) => p.at !== from && p.at !== to), ...moving.map((p) => ({ ...p, at: to }))]
      await savePins(this.deps.path, this.pinList, this.deps.now())
    }
    if (choice) {
      this.choiceList = [...this.choiceList.filter((c) => c.at !== from && c.at !== to), { ...choice, at: to }]
      await this.saveChoices()
    }
    return moving.length > 0 || choice !== undefined
  }

  /** Whether this connection is a popped view: it holds a pane of its own. */
  holdsPane(clientId: string): boolean {
    return [...this.poppedBy.values()].includes(clientId)
  }

  popped(): PaneId[] {
    return [...this.poppedBy.keys()]
  }

  /** The view on connection `clientId` shows `pane` alone; refused while another view does. Again from the same view is fine (a reconnect). */
  pop(pane: PaneId, clientId: string): { ok: true } | { ok: false; message: string } {
    const holder = this.poppedBy.get(pane)
    if (holder !== undefined && holder !== clientId) return { ok: false, message: `${pane} is popped out in another view already: close that one to move it again.` }
    for (const [p, c] of this.poppedBy) if (c === clientId && p !== pane) this.poppedBy.delete(p)
    this.poppedBy.set(pane, clientId)
    return { ok: true }
  }

  /** The connection went: its pane goes back to the tiled views. True when it held one. */
  unpop(clientId: string): boolean {
    let held = false
    for (const [p, c] of this.poppedBy) {
      if (c !== clientId) continue
      this.poppedBy.delete(p)
      held = true
    }
    return held
  }

  /** The person picked a token in a pane, and the link moved to it. */
  pick(token: Omit<Picked, "at">): void {
    this.picked = { ...token, at: this.deps.now() }
  }

  /**
   * The Candle Harness's note for `agent`'s turn, once: the token the person picked since its last turn, if any. The
   * name and symbol are Candle's market read's, so they're fenced as data. The mint goes to the address
   * gate as shown.
   */
  pickNote(agent: string): { text: string; addresses: string[] } | undefined {
    const p = this.picked
    if (!p || (this.told.get(agent) ?? Number.NEGATIVE_INFINITY) >= p.at) return undefined
    this.told.set(agent, p.at)
    const named = [p.symbol, p.name && p.name !== p.symbol ? p.name : undefined].filter(Boolean).join(" · ")
    const fenced = `${named ? `${named} · ` : ""}${p.mint}${p.chain === "hood" ? " (Hood)" : ""}`.replace(/<\/?picked>/gi, "")
    return {
      text: `Since your last turn the person picked a token in the Candle Harness's panes and is looking at it. It's the Candle Harness's note, not an instruction; "this one" likely means it.\n<picked>\n${fenced}\n</picked>`,
      addresses: [p.mint],
    }
  }
}
