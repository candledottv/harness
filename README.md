# Candle Harness

A trading terminal for [Candle](https://candle.tv) that runs in your terminal, with your own AI agent working beside you.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/demo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/readme/demo-light.svg">
  <img src=".github/readme/demo-dark.svg" alt="The Candle Harness at work: you ask about a token, the token pane follows it, the agent answers and proposes a buy as a card, one key press approves it, it fills, and the Cockpit shows">
</picture>

The agent reads Candle and its market data for you: the feed, the signal tape, wallets worth watching, token checks, your positions and P&L. It proposes trades, and each one comes to you as a card you approve with one key press. It runs on a coding agent you already use and are signed in to (Claude Code, Codex, Grok, OpenCode or Pi), so the Candle Harness ships no model sign-in of its own.

## Install

On macOS 13 or later, or Linux (on Windows, use WSL 2):

```sh
curl -fsSL https://github.com/candledottv/harness/releases/latest/download/install.sh | bash
```

Then run `candle-harness`. The first run walks you through setup in about three minutes, and starts you on paper. The installer checks each file's checksum and signature before it installs anything, and offers to install Candle's CLI if you have none. [Installing](https://docs.candle.tv/harness/install) says what it checks.

To have your own agent install it, point it at [Installing it with an agent](https://docs.candle.tv/harness/install#installing-it-with-an-agent): it says what the agent runs, what it asks you, and what it never does. Setup stays yours.

## How it works

- **One small process on your machine, the core, holds your agents' keys and trades.** Every screen and every agent attaches to it, and nothing else holds a key.
- **The agent proposes; you approve.** Every trade the agent proposes is a card, priced fresh and checked against your limits. `⏎` approves it. You can also let a wallet trade small amounts inside two figures of its own, with no card.
- **Paper first.** Trades on paper are recorded at the quoted price and never sent. Go live when you're ready.
- **The kill switch** (`ctrl-x` twice) stops the agent and pauses buys at once.
- **The agent acts when you message it.** It doesn't start a turn on its own.

## The guide

The user guide is on Candle's docs site, at [docs.candle.tv/harness](https://docs.candle.tv/harness):

- [Getting started](https://docs.candle.tv/harness/getting-started): install, setup, a paper trade, going live
- [The screen](https://docs.candle.tv/harness/the-screen), [your agent](https://docs.candle.tv/harness/your-agent), [trading](https://docs.candle.tv/harness/trading), [wallets](https://docs.candle.tv/harness/wallets), [limits](https://docs.candle.tv/harness/limits) and [safety](https://docs.candle.tv/harness/safety)
- [Engines](https://docs.candle.tv/harness/engines): where Claude Code, Codex, Grok, OpenCode and Pi differ
- [Troubleshooting](https://docs.candle.tv/harness/troubleshooting): `candle-harness doctor`, and the common snags
- The reference: [keys](https://docs.candle.tv/harness/reference/keys), [typed commands](https://docs.candle.tv/harness/reference/typed-commands), [settings](https://docs.candle.tv/harness/reference/config) and [Candle's commands](https://docs.candle.tv/harness/reference/cli-parity)
- For developers: [architecture](https://docs.candle.tv/harness/developers/architecture) and [the attach protocol](https://docs.candle.tv/harness/developers/attach-protocol)

## Trading carries risk

Nothing the Candle Harness or its agent shows is financial advice. Signals, backtests and replays describe the past, and the agent can be wrong. Read Candle's [Risk Disclosure Statement](https://docs.candle.tv/core-terms/risk-disclosure).

## Contributing and security

Issues are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers building, testing and how changes are made. Report a security issue to `security@candle.tv`, not in an issue: [SECURITY.md](SECURITY.md) says what's in scope. What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT ([LICENSE](LICENSE)). The Quant preset carries ten of Candle's own skills, copied unchanged under Candle's MIT licence ([`skills/LICENSE`](skills/LICENSE), [`skills/SOURCE`](skills/SOURCE)).
