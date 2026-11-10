// The code bots' client, as text, built into the binary: what `candle-harness bots init` and the Build tab write into
// a bots folder. One file, so the client a bot runs is always the one its core was built with.
// @ts-expect-error A TypeScript file imported as text: Bun reads it so, and TypeScript has no declaration for it.
import source from "../../client/harness-client.ts" with { type: "text" }

export const HARNESS_CLIENT_FILE = "harness-client.ts"
export const HARNESS_CLIENT_SOURCE: string = source as unknown as string
