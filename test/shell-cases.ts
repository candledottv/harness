// The shell rule's cases: tools.ts's shellAllows, and the copies in Pi's and OpenCode's
// gates, are each held to these.
import type { ShellSetting } from "../src/engine/tools"

export const SHELL_CASES: [ShellSetting, string, boolean][] = [
  [["ls"], "ls", true],
  [["ls"], "ls -la notes", true],
  [["ls"], "  ls\t-la", true],
  [["ls"], "lsof", false],
  [["ls"], "rm x", false],
  [["ls"], "ls; rm x", false],
  [["ls"], "ls && rm x", false],
  [["ls"], "ls || rm x", false],
  [["ls"], "ls | sh", false],
  [["ls"], "ls & rm x", false],
  [["ls"], "ls $(rm x)", false],
  [["ls"], "ls `rm x`", false],
  [["ls"], "ls\nrm x", false],
  [["ls"], "ls > out", false],
  [["ls"], "ls <(rm x)", false],
  [["ls"], "ls \\\nrm", false],
  [["ls"], '"rm" x', false],
  [["ls"], "'ls' x", false],
  [["ls"], 'ls "a b"', true],
  [["ls"], "", false],
  [["git log"], "git log --oneline", true],
  [["git log"], "git push", false],
  [["git log"], "git", false],
  ["everything", "rm -rf x; ls", true],
  ["off", "ls", false],
]
