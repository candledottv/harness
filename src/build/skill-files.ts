// Candle's bot-building skills, built into the binary: every file in build-skills/ but SOURCE, imported as text so
// `bun build --compile` carries them, for the bots folder the Build tab writes (folder.ts). LICENSE goes with them. A
// test checks this names exactly the files build-skills/SOURCE lists.
import B0 from "../../build-skills/candle-strategy-to-bot/SKILL.md" with { type: "text" }
import B1 from "../../build-skills/candle-trade-execution/SKILL.md" with { type: "text" }
import B2 from "../../build-skills/candle-kill-switches/SKILL.md" with { type: "text" }
import B3 from "../../build-skills/candle-book-limits/SKILL.md" with { type: "text" }
import B4 from "../../build-skills/candle-first-live-trade/SKILL.md" with { type: "text" }
import B5 from "../../build-skills/candle-agent-operations/SKILL.md" with { type: "text" }
import B6 from "../../build-skills/candle-market-data-ingestion/SKILL.md" with { type: "text" }
import B7 from "../../build-skills/candle-strategy-lab/SKILL.md" with { type: "text" }
import B8 from "../../build-skills/candle-wallet-layout/SKILL.md" with { type: "text" }
import LICENSE from "../../build-skills/LICENSE" with { type: "text" }

export const BUILD_SKILL_FILES: Record<string, Record<string, string>> = {
  "candle-strategy-to-bot": { "SKILL.md": B0 },
  "candle-trade-execution": { "SKILL.md": B1 },
  "candle-kill-switches": { "SKILL.md": B2 },
  "candle-book-limits": { "SKILL.md": B3 },
  "candle-first-live-trade": { "SKILL.md": B4 },
  "candle-agent-operations": { "SKILL.md": B5 },
  "candle-market-data-ingestion": { "SKILL.md": B6 },
  "candle-strategy-lab": { "SKILL.md": B7 },
  "candle-wallet-layout": { "SKILL.md": B8 },
}

/** Candle's MIT licence for these skills, written beside them. */
export const BUILD_SKILLS_LICENSE: string = LICENSE
