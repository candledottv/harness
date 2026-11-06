// Each harness's own sign-in, run in the prompt pane from onboarding. The
// list is fixed here, one command per engine, and nothing else runs this way: no arguments are typed, and
// the agent can't start one. It runs as the person, with their own HOME and environment, so the sign-in
// lands in the harness's own store, the one each engine's private home copies or links for a turn. The
// Candle Harness never sees or stores a model key: the harness takes it, by its own command.
//
// The commands and their screens, as recorded from each harness:
//   - Claude Code: `claude auth login` opens the browser and prints the link, then "Paste code here if prompted >";
//   - Codex: `codex login --device-auth`, a link and a code that expires in 15 minutes. The browser form holds a
//     fixed local port (1455), so two at once would clash, and it needs a browser on this machine;
//   - Grok: `grok login`, which is already the device form;
//   - OpenCode: `opencode auth login`, a searchable list of providers. It takes no provider on its command line;
//   - Pi: no sign-in command. Pi starts with its tools and extensions off, so nothing but its own `/login` can run.
// OpenCode's and Pi's lists offer Claude, ChatGPT and Grok subscriptions, which the Candle Harness holds back, so their
// step says so before the pane opens, and names the harness to use for each.
import type { Config } from "../config"
import type { EngineId } from "../engine/engine"

export interface HarnessSignIn {
  /** The words after the harness's binary. */
  args: readonly string[]
  /** Said before the pane opens: what to pick in the harness's own screens. */
  before?: string
  /** Said as the pane runs: what to type there. */
  typeThis?: string
}

/** What a Claude, ChatGPT or Grok subscription signed in through OpenCode or Pi does here. */
export const HELD_BACK =
  "A ChatGPT, Claude or Grok subscription signed in here won't be used: for those, use Codex, Claude Code or Grok, each with its own sign-in."

export const HARNESS_SIGN_INS: Readonly<Record<EngineId, HarnessSignIn>> = {
  "claude-code": { args: ["auth", "login"] },
  codex: { args: ["login", "--device-auth"] },
  grok: { args: ["login"] },
  opencode: {
    args: ["auth", "login"],
    before: `OpenCode's own sign-in opens next, as you. Pick OpenRouter, or a provider you have an API key for. ${HELD_BACK}`,
  },
  pi: {
    args: ["--no-tools", "--no-extensions"],
    before: `Pi opens next, as you, with its tools off. Type /login, then pick "Sign in with an API key" and a provider such as OpenRouter. ${HELD_BACK}`,
    typeThis: "type /login, then pick an API key; ctrl-c twice leaves Pi",
  },
}

/** The exact argv a harness's sign-in runs: its configured binary, then the fixed words. */
export function harnessSignInArgv(engine: EngineId, bin: string): string[] {
  return [bin, ...HARNESS_SIGN_INS[engine].args]
}

/** How to install a harness that isn't on this machine, in each engine's own words: copied by the person, never run by the Candle Harness. */
export const INSTALL_LINES: Readonly<Record<EngineId, string>> = {
  // Anthropic's own installer, which needs no Node: a fresh Mac has none.
  "claude-code": "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "npm install -g @openai/codex",
  grok: "x.ai/cli",
  opencode: "npm install -g opencode-ai",
  pi: "npm install -g @earendil-works/pi-coding-agent",
}

/** The binary config.toml names for an engine (engine.<name>.path). */
export function enginePathOf(config: Pick<Config, "engine">, id: EngineId): string {
  const key = ({ "claude-code": "claude", codex: "codex", grok: "grok", opencode: "opencode", pi: "pi" } as const)[id]
  return config.engine[key].path
}
