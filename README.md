# Candle Harness

**Trade from your terminal with an AI agent at your side.** The Candle Harness is a trading terminal for [Candle](https://candle.tv), with your own coding agent built in. It reads the market for you, proposes trades you take with one key, and keeps working on triggers and bots while you're away.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/demo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/readme/demo-light.svg">
  <img src=".github/readme/demo-dark.svg" alt="The Candle Harness at work: you ask about a token, the token pane follows it, the agent answers and proposes a buy as a card, one key press approves it, it fills, and the Cockpit shows">
</picture>

```sh
curl -fsSL https://github.com/candledottv/harness/releases/latest/download/install.sh | bash
```

macOS 13+ or Linux (WSL 2 on Windows). Then run `candle-harness`: setup takes about five minutes with your coding agent already signed in, and starts you on paper. Every file is signature-checked before it installs.

## What you get

- **Your agent, your engine.** Bring the coding agent you already use: Claude Code, Codex, Grok, OpenCode or Pi. No new model account to sign up for.
- **It reads the market for you.** Candle's feed, the signal tape, wallets worth watching, token checks, your positions and P&L, all in one terminal, and the agent pulls from all of it when you ask.
- **One key to trade.** The agent turns an idea into a priced trade card. Press `⏎` and it's done. Small trades inside figures you set can run without a card at all.
- **Triggers that keep watching.** A stop, a buy every morning, a signal to act on. Set it up with the agent once, and it runs with the window open or closed.
- **Rules bots.** Turn Hacc's signals into a strategy that buys on its own and sells by its own exits. *Pro and Max.*
- **Build your own bots.** The Build tab hands a folder of bots to your coding agent. It writes the bot, tests it on paper and proposes it; one press starts it. *Pro and Max.*
- **Try anything on paper.** Trades, triggers and bots on paper run at real quoted prices and send nothing. Go live when you like what you see.
- **Run it anywhere.** On your laptop, or on a [VPS](https://docs.candle.tv/harness/vps) so your bots keep going around the clock.

## Built to trust

- **One process holds your keys.** A small core on your machine holds them and trades, and nothing else does: not the agent, not your bots, which run with a token of their own.
- **You stay in charge.** Every trade follows the limits you set, and `ctrl-x` twice stops the agent and pauses every buy at once.
- **Open source** under MIT, with signed releases.

## Learn more

- [Getting started](https://docs.candle.tv/harness/getting-started): install, set up, make your first trade
- [Triggers](https://docs.candle.tv/harness/triggers), [rules bots](https://docs.candle.tv/harness/bots), [code bots](https://docs.candle.tv/harness/code-bots) and [the Build tab](https://docs.candle.tv/harness/build)
- [The full guide](https://docs.candle.tv/harness): wallets, limits, engines, troubleshooting and the reference
- [Installing it with your agent](https://docs.candle.tv/harness/install#installing-it-with-an-agent)
- For developers: [architecture](https://docs.candle.tv/harness/developers/architecture), [the attach protocol](https://docs.candle.tv/harness/developers/attach-protocol) and [the bot protocol](https://docs.candle.tv/harness/developers/bot-protocol)

## Contributing

Issues are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues to `security@candle.tv` ([SECURITY.md](SECURITY.md)). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT ([LICENSE](LICENSE)). The bundled Candle skills are MIT too: [`skills/`](skills/SOURCE) and [`build-skills/`](build-skills/SOURCE).

<sub>Not financial advice. Trading carries risk: read Candle's [Risk Disclosure Statement](https://docs.candle.tv/core-terms/risk-disclosure).</sub>
