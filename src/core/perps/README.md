# Perps

Where perps trading goes when it comes. Until then the Candle Harness is spot-only:

- the Perps tab is a stub over the short agent pane, saying perps on Hyperliquid come in a later update,
  with chips that put "show me Hyperliquid's biggest perps markets" and "what are my perps positions?" on
  the input line;
- the agent answers from Candle's perps reads (`candle_perps_markets`, `candle_perps_positions`,
  `candle_perps_account` and the rest), which the core classifies as reads;
- every perps write is refused with "Perps trading isn't in the Candle Harness yet".

Nothing here is built yet. The perps phase adds its reads to the core, its panes to the registry, and its
cards to the shared card path.
