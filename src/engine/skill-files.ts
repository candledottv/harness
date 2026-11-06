// Candle's skills, built into the binary (skills.ts): every file in skills/ but LICENSE
// and SOURCE, imported as text so \`bun build --compile\` carries them. Listed in the order the Quant prompt
// lists them. A test checks this names exactly the files skills/SOURCE lists.
import F0 from "../../skills/candle-risk-gate/SKILL.md" with { type: "text" }
import F1 from "../../skills/candle-trading-discipline/SKILL.md" with { type: "text" }
import F2 from "../../skills/candle-strategy-hunt/SKILL.md" with { type: "text" }
import F3 from "../../skills/candle-strategy-design/SKILL.md" with { type: "text" }
import F4 from "../../skills/onchain-strategy-research/SKILL.md" with { type: "text" }
import F5 from "../../skills/onchain-strategy-research/references/claim-register.md" with { type: "text" }
import F6 from "../../skills/onchain-strategy-research/references/research-protocol.md" with { type: "text" }
import F7 from "../../skills/onchain-strategy-research/references/the-game.md" with { type: "text" }
import F8 from "../../skills/candle-wallet-entry-detection/SKILL.md" with { type: "text" }
import F9 from "../../skills/candle-drained-pool-writeoff/SKILL.md" with { type: "text" }
import F10 from "../../skills/candle-transfer-fee-tokens/SKILL.md" with { type: "text" }
import F11 from "../../skills/candle-llm-trade-judge/SKILL.md" with { type: "text" }
import F12 from "../../skills/candle-market/SKILL.md" with { type: "text" }

export const SKILL_FILES: Record<string, Record<string, string>> = {
  "candle-risk-gate": { "SKILL.md": F0 },
  "candle-trading-discipline": { "SKILL.md": F1 },
  "candle-strategy-hunt": { "SKILL.md": F2 },
  "candle-strategy-design": { "SKILL.md": F3 },
  "onchain-strategy-research": { "SKILL.md": F4, "references/claim-register.md": F5, "references/research-protocol.md": F6, "references/the-game.md": F7 },
  "candle-wallet-entry-detection": { "SKILL.md": F8 },
  "candle-drained-pool-writeoff": { "SKILL.md": F9 },
  "candle-transfer-fee-tokens": { "SKILL.md": F10 },
  "candle-llm-trade-judge": { "SKILL.md": F11 },
  "candle-market": { "SKILL.md": F12 },
}
