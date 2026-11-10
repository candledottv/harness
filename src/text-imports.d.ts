// Markdown imported as text (`with { type: "text" }`), as the bundled skills are (engine/skill-files.ts).
declare module "*.md" {
  const text: string
  export default text
}

// A plain word list imported as text (shared/wallet-secret.ts's recovery-phrase words).
declare module "*.txt" {
  const text: string
  export default text
}
// Candle's licence for the bots folder's skills, which has no extension.
declare module "*/LICENSE" {
  const text: string
  export default text
}
