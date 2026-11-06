import { C } from "./theme"

export const MIN_COLS = 60
export const MIN_ROWS = 16

export function TooSmall(props: { width: number; height: number }) {
  return (
    <box width={props.width} height={props.height} backgroundColor={C.page} justifyContent="center" alignItems="center">
      <text fg={C.look}>{`Too small: ${props.width}×${props.height}. Candle Harness needs ${MIN_COLS}×${MIN_ROWS}.`}</text>
    </box>
  )
}
