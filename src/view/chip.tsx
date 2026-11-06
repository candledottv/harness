// The chip: everything that can be clicked is drawn as one, and
// nothing else is, so nothing can be clicked without showing it's a control. A
// control is blue on a tint; approve is the solid one, kill the one red one. Hover lightens the tint
// where the terminal reports mouse movement; the chip reads as a control without it.
import { useRenderer } from "@opentui/react"
import { useState } from "react"
import { C } from "./theme"

export type ChipKind = "control" | "primary" | "danger"

/** A chip's colours, by kind and hover. */
export function chipColours(kind: ChipKind, hover = false): { fg: string; bg: string } {
  switch (kind) {
    case "primary":
      return { fg: C.page, bg: hover ? C.hi : C.ctl }
    case "danger":
      return { fg: C.bad, bg: hover ? C.ctlHover : C.badBg }
    case "control":
      return { fg: C.ctl, bg: hover ? C.ctlHover : C.ctlBg }
  }
}

/**
 * The mouse pointer over something clickable is a hand, set with the terminal's
 * pointer sequence (OSC 22). Terminals that don't support it keep their own pointer.
 */
export function usePointer(onHover?: (over: boolean) => void): { onMouseOver: () => void; onMouseOut: () => void } {
  const renderer = useRenderer()
  return {
    onMouseOver: () => {
      renderer.setMousePointer("pointer")
      onHover?.(true)
    },
    onMouseOut: () => {
      renderer.setMousePointer("default")
      onHover?.(false)
    },
  }
}

/** The cells a chip's label takes: one space either side. */
export const chipText = (label: string): string => ` ${label} `

export function Chip(props: { label: string; kind?: ChipKind; onClick: () => void; colours?: { fg: string; bg: string } }) {
  const [hover, setHover] = useState(false)
  const pointer = usePointer(setHover)
  const { fg, bg } = props.colours ?? chipColours(props.kind ?? "control", hover)
  return (
    <box
      flexShrink={0}
      backgroundColor={bg}
      onMouseDown={(e: { stopPropagation?: () => void }) => {
        e.stopPropagation?.()
        props.onClick()
      }}
      {...pointer}
    >
      <text fg={fg} bg={bg}>
        {chipText(props.label)}
      </text>
    </box>
  )
}
