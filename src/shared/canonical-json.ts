// Canonical JSON for hashing cards: keys sorted by UTF-16 code unit at every depth, no whitespace,
// numbers and strings as JSON.stringify prints them. Anything JSON can't carry exactly is refused, so
// two encodings of the same card can never differ. An undefined field is left out; a null is kept, as
// `null`, since a profile edit clears a field with one and Candle reads it differently
// from a field left out.

export class NotCanonical extends Error {
  constructor(readonly at: string, what: string) {
    super(`can't encode ${what} at ${at || "the top level"} as canonical JSON`)
    this.name = "NotCanonical"
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, "")
}

function encode(value: unknown, at: string): string {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value)
    case "number":
      if (!Number.isFinite(value)) throw new NotCanonical(at, String(value))
      return JSON.stringify(value)
    case "object": {
      if (value === null) return "null"
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => {
          if (item === undefined) throw new NotCanonical(`${at}[${i}]`, "undefined")
          return encode(item, `${at}[${i}]`)
        }).join(",")}]`
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) throw new NotCanonical(at, proto?.constructor?.name ?? "an object")
      const parts: string[] = []
      for (const key of Object.keys(value).sort()) {
        const inner = (value as Record<string, unknown>)[key]
        if (inner === undefined) continue
        parts.push(`${JSON.stringify(key)}:${encode(inner, at ? `${at}.${key}` : key)}`)
      }
      return `{${parts.join(",")}}`
    }
    default:
      throw new NotCanonical(at, typeof value)
  }
}
