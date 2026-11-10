// The key two spellings of one address share. An EVM address is the same address in any case (its mixed case
// is only a checksum), so "0xAbC…" and "0xabc…" must match wherever addresses are compared: a wallet, a token,
// a bot's position. A Solana address is case-sensitive, and is its own key. The address as it was given is
// what's sent to Candle; the key is only ever compared.

/** The key two spellings of one address share: EVM ignores case; Solana doesn't. */
export const addressKey = (address: string): string => (address.startsWith("0x") || address.startsWith("0X") ? address.toLowerCase() : address)

/** Whether two addresses are the same one, whatever case an EVM address was written in. */
export const sameAddress = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && addressKey(a) === addressKey(b)
