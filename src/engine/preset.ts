// An agent's preset: which prompt and skills it runs on. Quant is the default; Trader is the plain trading
// prompt; Bare is the essentials only, for running light or with skills of your own. Your own skills go with
// every preset (engine/skills.ts). config's `[agents.<name>] preset` is where an agent starts, and the
// preset last picked in the Candle Harness is kept beside its engine and model (core/engine-state.ts).
export type Preset = "quant" | "trader" | "bare"
export const PRESETS: readonly Preset[] = ["quant", "trader", "bare"]
export const DEFAULT_PRESET: Preset = "quant"
export const PRESET_LABELS: Record<Preset, string> = { quant: "Quant", trader: "Trader", bare: "Bare" }
export const PRESET_DESCRIPTIONS: Record<Preset, string> = {
  quant: "an analyst as well as a trader: reads Candle's data first and uses Candle's skills",
  trader: "the plain trading prompt, without the analyst's rules or Candle's skills",
  bare: "the essentials only: light, or for your own skills",
}
export const isPreset = (value: unknown): value is Preset => (PRESETS as readonly unknown[]).includes(value)

