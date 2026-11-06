// One framed pane of a tab: rounded border, its title in the heading colour, and a lighter border when
// focused, never a meaning colour. A click focuses it; the wheel scrolls it where it scrolls; its border,
// dragged, resizes it where the layout can. Where the window has room (100×30 and up, as for the gaps
// between panes), a cell of air sits inside the border either side, so text never touches it and the panes
// read well spaced.
import type { MouseEvent } from "@opentui/core"
import type { ReactNode } from "react"
import type { Rect } from "../layout"
import { C } from "../theme"

/** A pane's border, grabbed: which side, then where the pointer is as it drags (a dragged border resizes). */
export type Edge = "left" | "right" | "top" | "bottom"
export interface PaneEdges {
  down(edge: Edge, x: number, y: number): void
  drag(x: number, y: number): void
  end(): void
}

/** The side of `rect`'s border at a cell, if it's on one; a corner counts as its left or right side. */
export function edgeAt(rect: Rect, x: number, y: number): Edge | undefined {
  if (x === rect.x) return "left"
  if (x === rect.x + rect.w - 1) return "right"
  if (y === rect.y) return "top"
  if (y === rect.y + rect.h - 1) return "bottom"
  return undefined
}

export function Pane(props: { rect: Rect; title: string; focused: boolean; onFocus: () => void; onScroll?: (delta: number) => void; edges?: PaneEdges; children?: ReactNode }) {
  const { rect, edges } = props
  return (
    <box
      position="absolute"
      left={rect.x}
      top={rect.y}
      width={rect.w}
      height={rect.h}
      border
      borderStyle="rounded"
      borderColor={props.focused ? C.focus : C.edge}
      // The title has its own colour: in the border's, an unfocused pane's title was all but invisible.
      titleColor={C.head}
      title={` ${props.title} `}
      backgroundColor={C.term}
      flexDirection="column"
      paddingLeft={padX}
      paddingRight={padX}
      onMouseDown={(e: MouseEvent) => {
        props.onFocus()
        const edge = edges ? edgeAt(rect, e.x, e.y) : undefined
        if (edge) edges!.down(edge, e.x, e.y)
      }}
      {...(edges ? { onMouseDrag: (e: MouseEvent) => edges.drag(e.x, e.y), onMouseDragEnd: () => edges.end() } : {})}
      {...(props.onScroll ? { onMouseScroll: (e: MouseEvent) => props.onScroll!(e.scroll?.direction === "up" ? 3 : -3) } : {})}
    >
      {props.children}
    </box>
  )
}

/** The rows inside a pane's border. */
export const innerRows = (rect: Rect) => Math.max(0, rect.h - 2)
/** The cells of air inside a pane's border, left and right: set by the frame each draw from the window's size. */
let padX = 0
export const setPanePadding = (cells: number) => {
  padX = cells
}
/** The columns inside a pane's border, less its air. */
export const innerCols = (rect: Rect) => Math.max(0, rect.w - 2 - 2 * padX)
