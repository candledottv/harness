// The tab bar: the tab you're on bright and underlined in the heading colour, the others in the control
// colour, since a click switches to them. The tabs come from layouts.toml. Right after them, the
// `settings ▾` chip opens what's set up once and rarely changed: the layout menu, themes, the model, memory
// and aliases (the corner under the kill switch was crowded).
//
// With eight tabs the names don't fit at 80 columns. The tab you're on always
// keeps its name; the others shrink to a digit and three letters, then to their digit, and `settings ▾`
// is never cut. The first nine tabs have digits; any after them shrink to their first letter, and where
// even that won't fit, they're left off the bar, reached by the palette.
//
// On a tab without the agent pane, the agent's change to the screen waiting on a click sits at the right:
// its layout previewed on this tab (keep, discard), a theme it made (undo), or a change to the tabs (undo).
// With the agent pane, those chips sit under its reply. A tab with a preview not on screen is marked `*` in
// the attention colour. Otherwise the right holds the tab's unsaved changes to its layout, `save as…` and
// `reset`, or the new tabs a layouts.toml left ticked off, until settings ▾ is opened.
import { TextAttributes } from "@opentui/core"
import { Chip, usePointer } from "./chip"
import { C, fit } from "./theme"

export const SETTINGS_CHIP = "settings ▾"

/** A tab as the bar draws it: its index among the tabs, its label, and whether it's marked `*` (the agent's preview on it). */
export interface TabLabel {
  index: number
  label: string
  marked: boolean
}

/** A tab's label at a shrink level: its digit and name, its digit and three letters, then its digit; past nine, the name alone, three letters, then one. */
function labelAt(name: string, i: number, level: number): string {
  const digit = i < 9 ? `${i + 1}` : undefined
  if (level === 0) return digit ? `${digit} ${name}` : name
  if (level === 1) return digit ? `${digit} ${name.slice(0, 3)}` : name.slice(0, 3)
  return digit ?? name.slice(0, 1)
}

/** The cells a label takes: its padding either side, and its `*`. */
const cells = (l: TabLabel) => l.label.length + 2 + (l.marked ? 1 : 0)
/** The settings chip's cells: its gap and the chip. */
const SETTINGS_CELLS = SETTINGS_CHIP.length + 3

/** The tabs as drawn in `width`: the least shrinking that fits the settings chip after them. */
export function tabLabels(tabs: readonly string[], tab: number, width: number, previewed?: readonly boolean[]): TabLabel[] {
  const at = (level: number) => tabs.map((name, i): TabLabel => ({ index: i, label: labelAt(name, i, i === tab ? 0 : level), marked: previewed?.[i] === true && i !== tab }))
  const fits = (ls: readonly TabLabel[]) => ls.reduce((n, l) => n + cells(l), 0) + SETTINGS_CELLS <= width - 1
  for (const level of [0, 1, 2]) {
    const ls = at(level)
    if (fits(ls)) return ls
  }
  // Still too wide: the tabs furthest from the one you're on are left off, the last first.
  const ls = at(2)
  while (!fits(ls) && ls.length > 1) {
    const others = ls.filter((l) => l.index !== tab)
    if (others.length === 0) break
    const far = others.reduce((a, l) => (Math.abs(l.index - tab) >= Math.abs(a.index - tab) ? l : a))
    ls.splice(ls.indexOf(far), 1)
  }
  return ls
}

/** The column the settings chip starts at: after each tab's label and its padding, and a gap. */
export const settingsColumn = (tabs: readonly string[], tab: number, width: number, previewed?: readonly boolean[]): number => tabLabels(tabs, tab, width, previewed).reduce((n, l) => n + cells(l), 0) + 1

export interface TabOffer {
  words: string
  chips: { label: string; onClick: () => void }[]
}

/** How wide the offer is drawn: its words, cut to what's left, then each chip with a space before it. */
const chipsWidth = (offer: TabOffer) => offer.chips.reduce((n, c) => n + c.label.length + 3, 0)

export function Tabs(props: { width: number; tabs: readonly string[]; tab: number; focused: boolean; onTab: (tab: number) => void; onSettings?: () => void; offer?: TabOffer; previewed?: readonly boolean[] }) {
  const pointer = usePointer()
  const labels = tabLabels(props.tabs, props.tab, props.width, props.previewed)
  const used = labels.reduce((n, l) => n + cells(l), 0) + (props.onSettings ? SETTINGS_CELLS : 0)
  const room = props.width - used - 1
  const offer = props.offer && room >= chipsWidth(props.offer) ? props.offer : undefined
  const words = offer ? fit(offer.words, Math.max(0, room - chipsWidth(offer) - 1)) : ""
  return (
    <box position="absolute" left={0} top={1} width={props.width} height={1} backgroundColor={C.page} flexDirection="row">
      {labels.map(({ index: i, label, marked }) => {
        const on = i === props.tab
        return (
          <box key={props.tabs[i]} paddingLeft={1} paddingRight={1} backgroundColor={on && props.focused ? C.sel : C.page} onMouseDown={() => props.onTab(i)} flexDirection="row" flexShrink={0} {...pointer}>
            <text fg={on ? C.hi : C.ctl} attributes={on ? TextAttributes.BOLD | TextAttributes.UNDERLINE : 0}>{label}</text>
            {marked ? <text fg={C.look}>*</text> : null}
          </box>
        )
      })}
      {props.onSettings ? (
        <box paddingLeft={1} flexShrink={0}>
          <Chip label={SETTINGS_CHIP} onClick={props.onSettings} />
        </box>
      ) : null}
      <box flexGrow={1} />
      {offer ? (
        <box flexDirection="row" flexShrink={0} paddingRight={1}>
          {words ? <text fg={C.look}>{`${words} `}</text> : null}
          {offer.chips.map((c, i) => (
            <box key={c.label} paddingLeft={i === 0 ? 0 : 1}>
              <Chip label={c.label} onClick={c.onClick} />
            </box>
          ))}
        </box>
      ) : null}
    </box>
  )
}
