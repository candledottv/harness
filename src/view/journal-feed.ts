// The Journal's rows, asked of the core with `journal.query` while a Journal pane is on
// screen: the first page when the search changes (a moment after the last key typed), again when the core
// records something the view hears of (its newest Activity line), and the next page when asked. Superseded
// and stale answers are dropped. Shared by the main view and a popped Journal.
import { useEffect, useRef } from "react"
import type { JournalPage } from "../core/journal-query"
import type { Session } from "./app"
import type { UiContext } from "./keys"
import { frameMaxScroll } from "./overlays"
import { type JournalHeld, type JournalRowsHeld, journalFilter, journalKey, journalRowsLines, type JournalSearch } from "./panes/journal"
import type { CoreView } from "./store"
import type { ChainSlug } from "../shared/chains"

/** How long after a key the search goes, so typing a word sends one query, not one a letter. */
export const SEARCH_SETTLE_MS = 150
/** A page's rows. */
export const PAGE_ROWS = 50

/**
 * A fresh first page over what's held: its rows replace theirs, and the older pages already read stay under
 * it, as long as they reach below it; otherwise the fresh page is the whole.
 */
export function mergeFirst(held: JournalHeld | undefined, page: JournalPage, key: string): JournalHeld {
  const fresh = page.entries
  const keep = held && held.key === key && held.entries.length > fresh.length && fresh.length > 0 ? held.entries.filter((e) => e.seq < fresh.at(-1)!.seq) : []
  const more = keep.length ? held!.more : page.more
  return { key, entries: [...fresh, ...keep], ...(more ? { more } : {}), ...(page.oldest ? { oldest: page.oldest } : {}) }
}

export function useJournal(input: {
  session: Session
  on: boolean
  search: JournalSearch | undefined
  /** The chain filter, while it's in force: only entries on that chain, and those about no token. */
  chain?: ChainSlug | undefined
  /** The newest thing the view has heard the core record: a new one reads the first page again. */
  newest: number | undefined
  held: () => JournalHeld | undefined
  got: (held: JournalHeld) => void
}): { older: () => void } {
  const { session, on, search, newest } = input
  const key = `${journalKey(search)}${input.chain ? ` · ${input.chain}` : ""}`
  const filter = () => ({ ...journalFilter(ref.current.search), ...(ref.current.chain ? { chain: ref.current.chain } : {}) })
  const ref = useRef(input)
  ref.current = input
  const asked = useRef(0)

  useEffect(() => {
    if (!on) return
    const ask = ++asked.current
    const held = ref.current.held()
    // A changed search shows "searching" until its page comes; a refresh keeps the rows on screen.
    if (held?.key !== key) ref.current.got({ key, entries: [], loading: "first" })
    // Typing waits a moment; the first read and a refresh for something new go at once.
    const timer = setTimeout(
      () => {
        session.request<JournalPage>("journal.query", { ...filter(), limit: PAGE_ROWS }).then(
          (page) => {
            if (ask !== asked.current || page.superseded) return
            ref.current.got(mergeFirst(ref.current.held(), page, key))
          },
          (error) => {
            if (ask !== asked.current) return
            const was = ref.current.held()
            ref.current.got({ ...(was?.key === key ? was : { key, entries: [] }), loading: undefined, failed: error instanceof Error ? error.message : String(error) } as JournalHeld)
          },
        )
      },
      held === undefined || held.key === key ? 0 : SEARCH_SETTLE_MS,
    )
    return () => clearTimeout(timer)
    // `key` is the search; `newest` a new row.
  }, [session, on, key, newest])

  return {
    older: () => {
      const held = ref.current.held()
      if (!held?.more || held.loading) return
      const ask = asked.current
      ref.current.got({ ...held, loading: "older" })
      session.request<JournalPage>("journal.query", { ...filter(), limit: PAGE_ROWS, before: held.more }).then(
        (page) => {
          const now = ref.current.held()
          if (ask !== asked.current || page.superseded || now?.key !== held.key) return
          const seen = new Set(now.entries.map((e) => e.id))
          const { loading: _l, more: _m, failed: _f, ...rest } = now
          ref.current.got({ ...rest, entries: [...now.entries, ...page.entries.filter((e) => !seen.has(e.id))], ...(page.more ? { more: page.more } : {}), ...(page.oldest ? { oldest: page.oldest } : {}) })
        },
        (error) => {
          const now = ref.current.held()
          if (now?.key !== held.key) return
          const { loading: _l, ...rest } = now
          ref.current.got({ ...rest, failed: error instanceof Error ? error.message : String(error) })
        },
      )
    },
  }
}

/** What the step needs of the Journal's rows: whether there's an older page, each row's seqs, and how far its details scroll at this size. */
export function journalContext(v: CoreView, size: { width: number; height: number }): NonNullable<UiContext["journal"]> {
  return {
    // While the next page is read, ↓ past the last row waits for it rather than leaving for the pane below.
    more: !!v.journal?.more || v.journal?.loading === "older",
    seqsOf: (id) => v.journal?.entries.find((e) => e.id === id)?.seqs,
    rowsMax: frameMaxScroll(journalRowsLines(v.journalRows), size.width, size.height, 0, v.journalRows?.rows?.length ? 1 : 0),
  }
}

/** A row's rows as recorded, for its details (ctrl-o): reading, then what the core sent or why not. */
export function readJournalRows(session: Session, ask: { id: string; seqs: number[] }, got: (held: JournalRowsHeld) => void): void {
  got({ id: ask.id })
  session.request<{ rows?: Record<string, unknown>[]; cut?: true }>("journal.rows", { seqs: ask.seqs }).then(
    (r) => got({ id: ask.id, rows: Array.isArray(r?.rows) ? r.rows : [], ...(r?.cut ? { cut: true as const } : {}) }),
    (error) => got({ id: ask.id, failed: error instanceof Error ? error.message : String(error) }),
  )
}
