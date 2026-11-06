// Fixes worded once, for the doctor and the panes that say the same thing: a pane that
// can't read gives the doctor's own fix line, so the two never disagree.

/** An agent whose key Candle or Hacc refuses: a new key, made by the owner and stored in the Candle Harness. */
export const newKeyFix = (agent: string) =>
  `Make a new key with \`candle keys create --access write --embedded-wallet allow --label ${agent}\`, then run \`candle-harness key add --agent ${agent}\`.`
