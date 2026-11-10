// Text from outside (token names, the agent's reasons, Candle's errors) made safe to draw. Anyone can
// name a token anything, so C0 and C1 controls and DEL go (no ESC, BEL or 8-bit CSI to start a
// sequence), and Unicode direction controls go (so text can't display reversed). So do the other
// invisible format characters (a lookalike "ETH" on Hacc's tape, Cyrillic Е, Greek Τ and
// Cyrillic Н with U+206F between each, drew three cells where its row counted five, and its columns
// slipped), Unicode's tag characters among them, which can carry text the person never sees while an
// agent reads it. So do the blank fillers and selectors Unicode says draw nothing (Hangul fillers, the
// grapheme joiner, variation selectors), which terminals draw at a width other than the one counted;
// a variation selector stays only right after an emoji, which it styles. Line and paragraph separators
// are line breaks, so a name can't carry one raw to the terminal. The zero-width joiner stays only between
// two emoji, which it joins into one ("👩‍💻"); anywhere else it and the non-joiner go, since a terminal may draw
// them as a glyph (a token named "Inu" and a joiner drew "InuĂ" in Apple's font) and the row's columns
// slip. Words aren't filtered.

const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const DIRECTION = /[؜‎‏‪-‮⁦-⁩]/g
/** Every other invisible format character (Unicode's Cf), but the zero-width joiner (`JOINER` says where it goes). */
const INVISIBLE = /(?!\u200d)\p{Cf}/gu
/** The zero-width joiner, but between two emoji (the first may carry its selector or a skin tone). */
const JOINER = /(?<!\p{Extended_Pictographic}[\ufe0f\u{1f3fb}-\u{1f3ff}]?)\u200d|\u200d(?!\p{Extended_Pictographic})/gu
/**
 * Every other character that draws nothing (Unicode's Default_Ignorable_Code_Point), but the joiners, and
 * an emoji's own variation selector (after the emoji, or before a keycap's ⃣).
 */
const IGNORABLE = /(?![\u200c\u200d\ufe0e\ufe0f])\p{Default_Ignorable_Code_Point}|(?<!\p{Extended_Pictographic})[\ufe0e\ufe0f](?!\u20e3)/gu
/** Unicode's line and paragraph separators. */
const SEPARATORS = /[\u2028\u2029]/g
// A high surrogate not followed by a low one, or a low one not preceded by a high one.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

export function terminalText(s: string, opts: { keepNewlines?: boolean; maxLength?: number } = {}): string {
  let out = s.replace(/\r\n?/g, "\n").replace(SEPARATORS, "\n").replace(/\t/g, " ")
  out = opts.keepNewlines ? out : out.replace(/\n/g, " ")
  out = out.replace(CONTROLS, "").replace(DIRECTION, "").replace(INVISIBLE, "").replace(JOINER, "").replace(IGNORABLE, "").replace(LONE_SURROGATE, "�")
  if (opts.maxLength !== undefined) {
    const points = Array.from(out)
    if (points.length > opts.maxLength) out = points.slice(0, opts.maxLength).join("")
  }
  return out
}

/**
 * Data from outside (a Candle answer, a card's result) as an agent gets it: every string and key cleaned as
 * text drawn on screen is, line breaks kept, so the agent reads what the person would see and nothing
 * hidden rides along. Numbers, ids, signatures and base64 are plain characters and pass as they are.
 */
export function cleanData(v: unknown): unknown {
  if (typeof v === "string") return terminalText(v, { keepNewlines: true })
  if (Array.isArray(v)) return v.map(cleanData)
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [terminalText(k), cleanData(x)]))
  return v
}
