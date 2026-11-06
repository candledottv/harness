import { version } from "../package.json"

// Set by scripts/build.ts through `--define` (scripts/commit.ts); not defined when run from source.
declare const CANDLE_HARNESS_BUILD_COMMIT: string | undefined
// Set by scripts/build.ts --release <tag> from the release's tag; package.json's version otherwise.
declare const CANDLE_HARNESS_BUILD_VERSION: string | undefined

export const VERSION: string = typeof CANDLE_HARNESS_BUILD_VERSION === "string" ? CANDLE_HARNESS_BUILD_VERSION : version
// Set to true by every compiled build (scripts/commit.ts SHIPPED_DEFINE); not defined when run from source.
declare const CANDLE_HARNESS_SHIPPED: boolean | undefined

/** A compiled build: harness.register, which only the tests use, is refused in it. */
export const SHIPPED: boolean = typeof CANDLE_HARNESS_SHIPPED === "boolean" && CANDLE_HARNESS_SHIPPED
/** The short commit the binary was built from, `+dirty` when the tree had changes, or `dev` from source. */
export const COMMIT: string = typeof CANDLE_HARNESS_BUILD_COMMIT === "string" ? CANDLE_HARNESS_BUILD_COMMIT : "dev"
