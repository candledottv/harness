// Copying: the ⧉ chips on addresses, and text selected with the mouse. On the machine
// the Candle Harness runs on, it writes the system clipboard itself (OpenTUI's host clipboard); over SSH, or where
// that can't, it asks the terminal with OSC 52, which Terminal.app ignores. The caller says which
// happened, so the message never claims a copy that didn't land.
import { createClipboard, createHostClipboard, createRendererClipboardAdapter, type RendererClipboardBoundary } from "@opentui/core"

export type Copied = "copied" | "sent" | "failed"

export interface Copier {
  copy(text: string): Promise<Copied>
  dispose(): Promise<void>
}

export function makeCopier(renderer: RendererClipboardBoundary): Copier {
  const service = createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) })
  return {
    async copy(text) {
      try {
        // Both: the system clipboard where the Candle Harness runs, and the terminal's (OSC 52). Inside a sandbox or over
        // SSH the first can't reach the user's machine, and the second is what lands.
        const r = await service.writeText(text, { destination: "all-available" })
        if (r.host.status === "written") return "copied"
        return r.terminal.status === "attempted" ? "sent" : "failed"
      } catch {
        return "failed"
      }
    },
    dispose: () => service.dispose(),
  }
}

/** What the message line says after a copy. `shown` is true when the text also shows in full, to select. */
export function copiedMessage(result: Copied, what: string, shown: boolean): { text: string; level: "info" | "error" } {
  const fallback = shown ? " It shows in full for 20 s, to select by hand." : ""
  if (result === "copied") return { text: `Copied ${what}.`, level: "info" }
  if (result === "sent") return { text: `Sent ${what} to your terminal's clipboard. If it didn't arrive, your terminal doesn't take copies from apps (Terminal.app doesn't).${fallback}`, level: "info" }
  return { text: `Couldn't copy ${what}.${fallback}`, level: "error" }
}
