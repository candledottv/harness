// A full repaint once a resize has settled (after a cmux split was dragged narrower, the popped Signals
// view kept cells from before, a title's second half and a grey block among its rows). OpenTUI
// 0.6.8 repaints only what changed after a resize in the alternate screen, and a terminal that rewraps its
// lines as it resizes leaves the rest stale. OpenTUI has no public call for it, so this sets the flag its
// own resize path sets in split-footer mode; OpenTUI is pinned, and a check in repaint.test.ts fails if the
// flag goes.
import { useEffect } from "react"

/** How long the size must hold before the repaint: a drag sends a stream of sizes. */
export const SETTLE_MS = 250

interface Repaintable {
  requestRender(): void
}

export function forceRepaint(renderer: Repaintable): boolean {
  const r = renderer as Repaintable & { forceFullRepaintRequested?: boolean }
  if (!("forceFullRepaintRequested" in r)) return false
  r.forceFullRepaintRequested = true
  r.requestRender()
  return true
}

export function useRepaintAfterResize(renderer: Repaintable, width: number, height: number): void {
  useEffect(() => {
    const timer = setTimeout(() => forceRepaint(renderer), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [renderer, width, height])
}
