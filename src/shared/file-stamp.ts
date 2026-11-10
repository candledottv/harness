// A config file's stamp, for a store that keeps the file parsed and reads it again only when it changed.
import { statSync } from "node:fs"

/** How long after a write the file is read again on every look, whatever its stamp. */
export const RECENT_MS = 2_000

/**
 * The file's stamp (modified time, size, inode), and whether it changed in the last moments; undefined with no file.
 * A modified time moves in ticks of a few milliseconds, so two writes of one size in one tick share a stamp: a file
 * changed that recently is read again whatever its stamp, so the second write isn't missed. The edge left: a same-size
 * write in the same tick as the last read is seen only if something reads the file within the next RECENT_MS, which
 * every store here does on its next look while anything uses it.
 */
export function fileStamp(path: string, now: number = Date.now()): { stamp: string; recent: boolean } | undefined {
  try {
    const s = statSync(path)
    return { stamp: `${s.mtimeMs}:${s.size}:${s.ino}`, recent: now - s.mtimeMs < RECENT_MS }
  } catch {
    return undefined
  }
}
