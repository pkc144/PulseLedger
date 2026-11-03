/**
 * The API carries money as integer minor units in a decimal string ("250000" = 2,500.00), never as
 * a JSON number. These helpers keep it that way: parsing and formatting are string/BigInt work, so
 * no amount ever passes through a float.
 */
const minorDigits = 2; // INR and USD, the API's whole currency set, both have two decimal places.

const symbols: Record<string, string> = { INR: '₹', USD: '$' };

export function formatMinor(amountMinor: string, currency: string): string {
  const negative = amountMinor.startsWith('-');
  const digits = (negative ? amountMinor.slice(1) : amountMinor).padStart(minorDigits + 1, '0');
  const major = digits.slice(0, -minorDigits);
  const minor = digits.slice(-minorDigits);
  const grouped = BigInt(major).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US');
  return `${negative ? '−' : ''}${symbols[currency] ?? `${currency} `}${grouped}.${minor}`;
}

/**
 * "2500", "2,500.5", "2500.05" → "250000", "250050", "250005". Returns null for anything that is
 * not a positive amount with at most two decimals; the server re-validates regardless.
 */
export function parseMajorToMinor(input: string): string | null {
  const cleaned = input.replace(/[,\s]/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(minorDigits, '0') || '0');
  return minor > 0n ? minor.toString() : null;
}
