// Clicks that never turn into a selection.
//
// The renderer starts a selection on a press over text and ends it on the release. Two things go wrong in a real
// terminal:
//
// - A release can be lost (the window was raised by the press, or the press landed in an embedded terminal), so
//   the renderer still thinks the button is down: every later pointer move stretches the old selection, and the
//   next press is taken as part of it rather than as a click. Two quick clicks on two tabs then select everything
//   between them and switch nothing.
// - A press and release on the same cell leave a one-cell selection behind, and a press that carries ctrl (as one
//   straight after a ctrl chord can, the modifier still flagged) stretches whatever selection is there to the
//   pointer instead of clicking. So a click on a tab right after ctrl-] or ctrl-c selected from the last click to
//   the tab, switched nothing, and each later click stretched it further.
//
// The guard wraps the renderer's own mouse handling: a press that comes with no release since the last press ends
// whatever the old one left behind and starts fresh, a press is a click whatever modifier it carries, and a release
// on the cell it was pressed on leaves no selection. A drag still selects; a double or triple click still selects a
// word or a line.

type MouseEv = { type: string; button: number; x: number; y: number; modifiers?: { ctrl?: boolean } }
type SelectionLike = { isDragging: boolean; behavior?: string; anchor: { x: number; y: number }; focus: { x: number; y: number } }
type RendererInside = {
  processSingleMouseEvent(e: MouseEv): boolean
  currentSelection?: SelectionLike | null
  capturedRenderable?: unknown
  pressedRenderable?: unknown
  clearSelection(): void
  clearSelectionState?: () => void
}

const LEFT = 0

/** Wraps `renderer`'s mouse handling; the returned function puts it back. */
export function guardMouse(renderer: unknown): () => void {
  const r = renderer as RendererInside
  if (typeof r.processSingleMouseEvent !== "function") return () => {}
  const own = r.processSingleMouseEvent
  let pressed = false
  const guarded = function (this: unknown, ev: MouseEv): boolean {
    const left = ev.button === LEFT
    const e = left && ev.modifiers?.ctrl && (ev.type === "down" || ev.type === "up") ? { ...ev, modifiers: { ...ev.modifiers, ctrl: false } } : ev
    if (e.type === "down" && left) {
      if (pressed || r.currentSelection?.isDragging) {
        // The last press's release never came: nothing of it carries into this click.
        if (r.currentSelection) r.currentSelection.isDragging = false
        r.clearSelection()
        r.capturedRenderable = undefined
        r.pressedRenderable = undefined
      }
      pressed = true
    }
    if (e.type === "up" && left) {
      pressed = false
      const s = r.currentSelection
      if (s?.isDragging && (s.behavior ?? "cell") === "cell" && same(s.anchor, s.focus) && same(s.anchor, e)) {
        // A click, not a drag: no selection, and the release goes on to what's under it as a click's would.
        s.isDragging = false
        if (r.clearSelectionState) r.clearSelectionState.call(r)
        else r.clearSelection()
      }
    }
    return own.call(this ?? r, e)
  }
  r.processSingleMouseEvent = guarded
  return () => {
    if (r.processSingleMouseEvent === guarded) r.processSingleMouseEvent = own
  }
}

const same = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y
