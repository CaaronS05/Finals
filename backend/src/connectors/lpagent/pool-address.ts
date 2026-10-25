/**
 * Pool address input contract.
 *
 * Solana addresses are base58 and CASE-SENSITIVE. Lowercasing one produces a
 * different, usually nonexistent, address. Nothing here transforms case.
 *
 * SYNTACTIC VALIDITY IS NOT EXISTENCE
 * ----------------------------------
 * `parsePoolAddress` decides only whether the string is a well-formed base58
 * value of the right length. It does not contact the provider, does not
 * checksum against Solana tooling, and cannot know whether a Meteora DLMM pool
 * exists at that address. Existence verification belongs to live acquisition.
 */
/** Length of a Solana base58 address. */
export const POOL_ADDRESS_LENGTH = 32;

/**
 * Base58 alphabet. Excludes 0, O, I, and l, which are the characters most
 * often lost to copy/paste and font confusion.
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Outcome of a pool address parse. */
export type PoolAddressParseResult =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly reason: PoolAddressRejectionReason; readonly input: string };

/** Why an input was rejected. Machine-readable, no provider knowledge. */
export type PoolAddressRejectionReason =
  | "EMPTY"
  | "NOT_A_STRING"
  | "WRONG_LENGTH"
  | "INVALID_BASE58"
  | "WHITESPACE";

function reject(
  reason: PoolAddressRejectionReason,
  input: string,
): PoolAddressParseResult {
  return { ok: false, reason, input };
}

/**
 * Validate a pool address without transforming it.
 *
 * Rejects empty, non-string, wrong-length, non-base58, and padded input.
 * Trimming is NOT performed: a padded address is reported as WHITESPACE so a
 * caller sees the mistake instead of having it silently repaired into a
 * different identity.
 */
export function parsePoolAddress(value: unknown): PoolAddressParseResult {
  if (typeof value !== "string") {
    return reject("NOT_A_STRING", describe(value));
  }
  if (value.length === 0) {
    return reject("EMPTY", value);
  }
  if (value !== value.trim()) {
    return reject("WHITESPACE", value);
  }
  if (value.length !== POOL_ADDRESS_LENGTH) {
    return reject("WRONG_LENGTH", value);
  }
  for (const char of value) {
    if (!BASE58_ALPHABET.includes(char)) {
      return reject("INVALID_BASE58", value);
    }
  }
  return { ok: true, address: value };
}

/** True when the value is a syntactically valid pool address. */
export function isPoolAddress(value: unknown): value is string {
  return parsePoolAddress(value).ok;
}

/** Describe a non-string input for an error message without leaking content. */
function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "object") {
    return `[${Array.isArray(value) ? "array" : "object"}]`;
  }
  return String(value);
}
