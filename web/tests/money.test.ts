import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatMinor, parseMajorToMinor } from '../src/lib/money';

/**
 * money.ts is the only place in the UI where an amount changes shape -- typed text becomes the
 * minor-unit string the API takes, and the API's string becomes what a person reads. A bug here
 * moves the wrong amount of money with no error anywhere, so it is tested by example and by
 * property, with amounts far beyond Number.MAX_SAFE_INTEGER.
 */

const positiveMinor = fc.bigInt({ min: 1n, max: 10n ** 30n });
const anyMinor = fc.bigInt({ min: 0n, max: 10n ** 30n });
const currency = fc.constantFrom('INR', 'USD');

/** formatMinor's output without its sign and currency symbol: "2,500.00". */
const unsigned = (formatted: string) => formatted.replace(/^−?[₹$]/, '');
const digitsOf = (formatted: string) => formatted.replace(/\D/g, '');

describe('formatMinor', () => {
  it.each([
    ['250000', 'INR', '₹2,500.00'],
    ['12345678901', 'INR', '₹12,34,56,789.01'],
    ['12345678901', 'USD', '$123,456,789.01'],
    ['5', 'USD', '$0.05'],
    ['0', 'USD', '$0.00'],
    ['100', 'INR', '₹1.00'],
    ['-174001', 'INR', '−₹1,740.01'],
    ['9223372036854775807', 'USD', '$92,233,720,368,547,758.07'],
  ])('%s %s → %s', (minor, code, expected) => {
    expect(formatMinor(minor, code)).toBe(expected);
  });

  it('never adds or drops a digit, at any size', () => {
    fc.assert(
      fc.property(anyMinor, currency, (minor, code) => {
        expect(digitsOf(formatMinor(minor.toString(), code))).toBe(
          minor.toString().padStart(3, '0'),
        );
      }),
    );
  });

  it('groups INR the Indian way and USD the Western way, with identical digits', () => {
    fc.assert(
      fc.property(anyMinor, (minor) => {
        const inr = unsigned(formatMinor(minor.toString(), 'INR'));
        const usd = unsigned(formatMinor(minor.toString(), 'USD'));
        expect(digitsOf(inr)).toBe(digitsOf(usd));
        expect(inr.split('.')[0]).toMatch(/^(\d{1,3}|\d{1,2}(,\d{2})*,\d{3})$/);
        expect(usd.split('.')[0]).toMatch(/^\d{1,3}(,\d{3})*$/);
      }),
    );
  });

  it('marks negatives (treasury balances) without changing the amount', () => {
    fc.assert(
      fc.property(positiveMinor, currency, (minor, code) => {
        const negative = formatMinor(`-${minor}`, code);
        expect(negative.startsWith('−')).toBe(true);
        expect(negative.slice(1)).toBe(formatMinor(minor.toString(), code));
      }),
    );
  });
});

describe('parseMajorToMinor', () => {
  it.each([
    ['2500', '250000'],
    ['2,500.5', '250050'],
    ['2500.05', '250005'],
    ['0.01', '1'],
    ['12,34,567.89', '123456789'],
    [' 1 000 ', '100000'],
    ['007', '700'],
  ])('%j → %s', (input, expected) => {
    expect(parseMajorToMinor(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['0', 'zero'],
    ['0.00', 'zero with decimals'],
    ['-5', 'negative'],
    ['1.234', 'three decimals: a fraction of a paisa'],
    ['1.', 'trailing point'],
    ['.5', 'no whole part'],
    ['1e3', 'exponent'],
    ['₹100', 'currency symbol'],
    ['12abc', 'letters'],
    ['Infinity', 'non-finite'],
  ])('refuses %j (%s)', (input) => {
    expect(parseMajorToMinor(input)).toBeNull();
  });

  it('round-trips with formatMinor for every positive amount, in both groupings', () => {
    fc.assert(
      fc.property(positiveMinor, currency, (minor, code) => {
        expect(parseMajorToMinor(unsigned(formatMinor(minor.toString(), code)))).toBe(
          minor.toString(),
        );
      }),
    );
  });

  it('only ever returns null or what the transfer schema accepts, for any input at all', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (input) => {
        const parsed = parseMajorToMinor(input);
        if (parsed !== null) expect(parsed).toMatch(/^[1-9][0-9]*$/);
      }),
      { numRuns: 2000 },
    );
  });

  it('is exact where a float would not be', () => {
    // 0.1 + 0.2 territory, and a value past 2^53 where Number loses the last digits.
    expect(parseMajorToMinor('0.29')).toBe('29');
    expect(parseMajorToMinor('90071992547409.93')).toBe('9007199254740993');
  });
});
