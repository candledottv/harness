// Markdown imported as text (`with { type: "text" }`), as the bundled skills are (engine/skill-files.ts).
declare module "*.md" {
  const text: string
  export default text
}

// A plain word list imported as text (engine/wallet-secret.ts's recovery-phrase words).
declare module "*.txt" {
  const text: string
  export default text
}
