import { C } from "./theme"

export const MIN_COLS = 60
export const MIN_ROWS = 16

/**
 * `cards`: how many wait. No key approves one from here; the kill switch still works, so its first press and the
 * switch on are said here too, where the status bar that says them elsewhere isn't drawn.
 */
export function TooSmall(props: { width: number; height: number; cards?: number; killArmed?: boolean; paused?: boolean }) {
  const kill = props.paused ? "Kill switch on: buys paused. Sells still work." : props.killArmed ? "ctrl-x again to kill" : undefined
  return (
    <box width={props.width} height={props.height} backgroundColor={C.page} flexDirection="column" justifyContent="center" alignItems="center">
      <text fg={C.look}>{`Too small: ${props.width}×${props.height}. Candle Harness needs ${MIN_COLS}×${MIN_ROWS}.`}</text>
      {props.cards ? <text fg={C.dim}>{`${props.cards === 1 ? "1 card waits" : `${props.cards} cards wait`}${props.paused ? "" : " · ctrl-x ×2 still kills"}`}</text> : null}
      {kill ? <text fg={C.bad}>{kill}</text> : null}
    </box>
  )
}
