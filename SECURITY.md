# Security

The Candle Harness holds trading keys and moves funds, so we want to hear about anything that breaks the rules it promises to hold.

## Reporting

Email **security@candle.tv**. Please don't open a public issue. For anything that puts funds at risk, put **CRITICAL** in the subject line.

Reports are handled under Candle's [Vulnerability Disclosure Policy](https://docs.candle.tv/rights-and-reporting/vulnerability-disclosure): how to report, what Candle commits to in return, the safe harbour for good-faith research, and the rules (stop at proof, use your own accounts and test funds, give 90 days before disclosing). Please include the Candle Harness version (`candle-harness version`), your platform, the engine and its version if one was involved, and steps to reproduce.

## Supported versions

The latest release. Fixes ship as a new release, and `install.sh` installs it. A core that's already running keeps the version it started as until it's restarted: after an update, run `candle-harness stop`, then open `candle-harness` again (the installer, the doctor and the status bar say when one is still on the older version).

## What's in scope for the Candle Harness

Candle's policy covers Candle's contracts, API and apps. For the Candle Harness, these are in scope: anything that breaks what the Candle Harness says it holds, on a machine that isn't otherwise compromised.

- **A key reaching what shouldn't hold it:** an agent's Candle key, the vault's passphrase or recovery phrase, or a harness's sign-in reaching the agent, a view, the screen, the journal or a log. (A harness's sign-in goes to its own provider, and nowhere else.)
- **A trade without your press:** a trade, swap, launch, stake or other card run without the press from a main view (other than a trade inside the figures of a wallet you let trade inside limits), run twice, or run differently from the card you approved.
- **A trade outside the limits:** a trade the Candle Harness runs past an agent's limits, a wallet's figures, or the kill switch, or a wallet's autonomy widened by anything other than you in the main view.
- **Funds out:** a transfer or sweep the agent starts without your own message naming it, or a look-alike or unknown destination getting past its check.
- **The prompt pane leaking:** anything shown or typed in it reaching the core, the agent or a view, or its ticket redeemed by any process but the one the view named.
- **The agent getting out of its folder:** with the shell off, an engine reading or writing outside its research folder, reaching a tool the core hides, or loading your own setup of its harness. A script the code runner runs reaching outside its research folder or the network.
- **A bot getting past its card:** a code bot or a Build pane reaching a key or another bot, a code bot trading past its card's figures, choosing its own mode, wallet, agent or slippage, selling what isn't its own, or a request sent twice; the Build pane's token approving or trading anything.
- **Third-party text taking control:** a signal, post, token name or address that the Candle Harness shows or passes to the agent being able to drive the terminal, or to act without your press.
- **The installer and releases:** `install.sh` installing a file whose checksum or signature doesn't match the release.

## Out of scope

- **Hostile code already running as your user.** The tokens between the Candle Harness's processes protect against cooperative agents, not malware: anything that can read your files can read them. The same goes for a compromised machine or a malicious terminal.
- **An agent's shell once you've turned it on.** It runs as you, and the Candle Harness says so where you turn it on.
- **What your own code does,** in a code bot or in the Build tab's harness, outside the core. Both run as you and can read what you can; what's in scope is their reach through the core.
- **What the model decides.** A bad trade the agent proposes, shown on a card for you to approve or reject, is the Candle Harness working as designed. A model refusing to follow the rules is in scope only when it gets past one.
- **Commands run outside the Candle Harness,** in another terminal, a script, or Candle's app. Candle's own caps on the key hold those.
- **Bugs in a harness itself** (Claude Code, Codex, Grok, OpenCode, Pi) that don't get past a hold the Candle Harness adds. Report those to their makers.
- **Candle's services, and the third-party services Candle uses.** Those come under Candle's policy, and its own out-of-scope list.

[Architecture](https://docs.candle.tv/harness/developers/architecture) describes the processes, where each key lives and the trust boundary, and [Safety](https://docs.candle.tv/harness/safety) what the Candle Harness holds, in a trader's words.
