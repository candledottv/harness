// The P&L chart's points, asked of the core with `pnl.series` while a P&L chart is on
// screen: again when its span changes and whenever the `pnl` topic says a book was read, so the chart
// moves with the figures beside it. Shared by the main view and a popped P&L chart.
import { useEffect } from "react"
import type { PnlView } from "../core/pnl"
import type { Session } from "./app"
import { type PnlSeries, type PnlSpan, SERIES_POINTS, spanFrom } from "./panes/pnl"

export function usePnlSeries(session: Session, on: boolean, span: PnlSpan, pnl: PnlView | undefined, now: () => number, got: (series: PnlSeries) => void): void {
  useEffect(() => {
    if (!on) return
    let live = true
    const at = now()
    const from = spanFrom(span, pnl, at)
    session.request<{ points?: unknown }>("pnl.series", { from, points: SERIES_POINTS }).then(
      (r) => {
        if (live) got({ span, from, at, points: Array.isArray(r?.points) ? (r.points as PnlSeries["points"]) : [] })
      },
      (error) => {
        if (live) got({ span, from, at, points: [], failed: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
    // `got` and `now` are the frame's own, stable for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, on, span, pnl])
}

/** The panes that read the `pnl` topic. */
export const PNL_PANES = ["pnl", "pnl-chart", "pnl-positions", "trades"] as const
