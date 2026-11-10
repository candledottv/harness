// A token's name as the words show it. Anyone can name a token anything, and a name with Cyrillic or Greek
// letters that look Latin ("ѕame" with a Cyrillic ѕ, "Сoin", "Еlon" beside a real "COIN") reads exactly as
// another token's. Such a name is shown with its short address beside it ("Сoin (Cfq1…4pmp)"), so two tokens
// can be told apart. It's rare by design: a name in plain Latin, or one wholly in another script that isn't
// made of Latin look-alikes ("Привет", "柴犬"), shows as it is.

import { short } from "../core/wallet-names"

/** Cyrillic and Greek letters drawn like a Latin one. */
const LOOKALIKES = new Set([..."АВСЕНІЈКМОРЅТХУаеіјорсѕхуһԁԛԝҮүӏԌԍӀ", ..."ΑΒΕΖΗΙΚΜΝΟΡΤΥΧοαινυ"])
const LETTER = /\p{L}/u
const LATIN = /\p{Script=Latin}/u

/** Whether a name could pass for another: Latin look-alikes among Latin letters, or a name made only of them. */
export function looksLikeAnother(name: string): boolean {
  const letters = [...name].filter((c) => LETTER.test(c))
  const alike = letters.filter((c) => LOOKALIKES.has(c))
  if (!alike.length) return false
  return letters.some((c) => LATIN.test(c)) || alike.length === letters.length
}

/** The name with the short address beside it where it could pass for another token's; unchanged otherwise. */
export function tokenLabel(name: string | undefined, mint: string): string | undefined {
  if (name === undefined) return undefined
  return looksLikeAnother(name) ? `${name} (${short(mint)})` : name
}
