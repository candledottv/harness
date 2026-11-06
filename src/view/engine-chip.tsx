// The agent pane's engine chip: `engine · model ▾` on the pane's top border, blue like every clickable
// thing: what the agent's next turn runs on. Short, since a header of preset, memory and model was long and
// confusing: no preset, no memory count, and no "last → next"; the preset is in the picker, the memory
// under the palette's memory rows, and a switch in Activity. A click opens the picker, as ctrl-g does.
import { ENGINE_LABELS, type EngineId } from "../engine/engine"
import { Chip, chipText } from "./chip"
import type { Rect } from "./layout"
import type { EngineTopic } from "./panes/engines"
import { C } from "./theme"

/** A model's name without its provider's path: `openrouter/deepseek/deepseek-v4.1-flash` is `deepseek-v4.1-flash`. */
const modelName = (model: string) => model.split("/").at(-1) || model

/**
 * The agent pane's chip: the engine the next turn runs on, and its model: the one picked, else the one
 * the engine's last turn answered on, else the engine's default by name, else none. Undefined before the
 * core says.
 */
export function engineChipText(topic: EngineTopic | undefined, agent: string): string | undefined {
  const choice = topic?.agents[agent]
  if (!topic || !choice) return undefined
  const label = (id: EngineId) => topic.engines[id]?.label ?? ENGINE_LABELS[id]
  const last = choice.last?.engine === choice.engine ? (choice.last.answeredModel ?? choice.last.model) : undefined
  const model = choice.model ?? last ?? topic.engines[choice.engine]?.defaultModel
  return `${label(choice.engine)}${model ? ` · ${modelName(model)}` : ""} ▾`
}

/** Where the chip goes on the agent pane's border, cut to the room the title leaves: the model's name is trimmed first, being only a reference. */
export function borderChip(width: number, title: string, text: string): string | undefined {
  // The border's corners, the title's own padding and a gap either side.
  const room = width - title.length - 4 - 2 - 4
  if (room < 8) return undefined
  return text.length + 2 <= room ? text : trimTo(text, room - 2)
}

/** A chip's text cut to `max` characters, the cut marked with … before the ▾. */
function trimTo(t: string, max: number): string {
  if (t.length <= max) return t
  const body = t.replace(/ ▾$/, "")
  return `${body.slice(0, Math.max(1, max - 3))}… ▾`
}

/** The chip on the agent pane's top border, right-aligned. */
export function EngineChip(props: { rect: Rect; title: string; text: string; onClick: () => void }) {
  const label = borderChip(props.rect.w, props.title, props.text)
  if (!label) return null
  const width = chipText(label).length
  return (
    <box position="absolute" left={props.rect.x + props.rect.w - width - 2} top={props.rect.y} height={1} flexDirection="row" backgroundColor={C.term}>
      <Chip label={label} onClick={props.onClick} />
    </box>
  )
}
