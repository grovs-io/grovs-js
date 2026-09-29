import { describe, expect, it } from 'vitest';
import { readTimestamp } from '../../src/inapp/definition';
import { fill } from '../../src/inapp/personalize';
import { compare, compareVersions, percentEncode, textOf } from '../../src/inapp/values';

describe('text form', () => {
  it('never writes a number with an exponent', () => {
    expect(textOf(1e21)).toBe('1000000000000000000000');
    expect(textOf(1.5e21)).toBe('1500000000000000000000');
    expect(textOf(1e-7)).toBe('0.0000001');
    expect(textOf(1.5e-10)).toBe('0.00000000015');
    expect(textOf(-2.5e-8)).toBe('-0.000000025');
    expect(textOf(123456789.125)).toBe('123456789.125');
  });

  it('writes whole numbers with no decimal point, and zero without a sign', () => {
    expect(textOf(42.0)).toBe('42');
    expect(textOf(-0)).toBe('0');
    expect(textOf(0.30000000000000004)).toBe('0.30000000000000004');
  });

  it('has none for null, lists, objects and numbers that are not finite', () => {
    for (const value of [null, undefined, [], [1], {}, { a: 1 }, NaN, Infinity]) expect(textOf(value)).toBeNull();
  });
});

describe('compare', () => {
  it('treats a list or object as not present', () => {
    expect(compare({ a: 1 }, 'is_set', undefined)).toBe(false);
    expect(compare(['a'], 'is_not_set', undefined)).toBe(true);
  });

  it('fails on a range that is not two numbers, or is reversed', () => {
    expect(compare(3, 'between', 5)).toBe(false);
    expect(compare(3, 'between', [1, 2, 3])).toBe(false);
    expect(compare(3, 'between', [1, 'many'])).toBe(false);
    expect(compare(3, 'between', [5, 1])).toBe(false);
    expect(compare(3, 'between', [1, '5'])).toBe(true);
  });

  it('does not read a plus sign, an exponent or a trailing dot as a number', () => {
    for (const written of ['+1', '1e3', '1.', '.5', ' 1']) expect(compare(written, 'gt', 0)).toBe(false);
  });

  it('fails an operator it does not know', () => {
    expect(compare('a', 'like', 'a')).toBe(false);
  });
});

describe('versions', () => {
  it('ignores everything from the first character that is not a digit or a dot', () => {
    expect(compareVersions('2.1.0-beta', 'eq', '2.1.0')).toBe(true);
    expect(compareVersions('17.4-beta.2', 'eq', '17.4')).toBe(true);
    expect(compareVersions('beta', 'eq', '0')).toBe(true);
  });

  it('compares parts as numbers', () => {
    expect(compareVersions('2.10', 'gt', '2.9')).toBe(true);
    expect(compareVersions('2.1', 'eq', '2.1.0.0')).toBe(true);
  });

  it('fails when the device reports no version', () => {
    for (const operator of ['eq', 'neq', 'gt', 'lt']) expect(compareVersions('', operator, '1.0')).toBe(false);
    expect(compareVersions(null, 'between', ['1', '2'])).toBe(false);
  });
});

describe('percentEncode', () => {
  it('keeps only letters, digits and - . _ ~', () => {
    expect(percentEncode("a!'()*+ é~-._Z9")).toBe('a%21%27%28%29%2A%2B%20%C3%A9~-._Z9');
  });

  it('survives half of a surrogate pair', () => {
    expect(percentEncode('a\uD83Db')).toBe('a%EF%BF%BDb');
    expect(percentEncode('a\uDE00b')).toBe('a%EF%BF%BDb');
    expect(percentEncode('😀')).toBe('%F0%9F%98%80');
  });
});

describe('fill', () => {
  const sources = { user: { name: 'Ana', constructor: 'x' }, event: {} };

  it('does not read inherited properties as values', () => {
    expect(fill('{{ event.constructor | default: "none" }}', sources)).toBe('none');
    expect(fill('{{ event.toString }}', sources)).toBeNull();
  });

  it('does not fill a field that a value brought in', () => {
    expect(fill('{{ user.name }}', { user: { name: '{{ user.secret }}' }, event: {} })).toBe('{{ user.secret }}');
  });
});

describe('readTimestamp', () => {
  it('refuses times that are not on the calendar or not in the contract form', () => {
    for (const written of [
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-09-01T24:00:00Z',
      '2026-09-01T00:00:60Z',
      '2026-09-01T00:00:00z',
      '2026-09-01T00:00:00.1234Z',
      '2026-09-01T00:00:00Z\nx',
      '2026-09-01',
    ]) {
      expect(readTimestamp(written)).toBeNull();
    }
  });

  it('reads a leap day and fractions of a second', () => {
    expect(readTimestamp('2028-02-29T00:00:00Z')).toBe(Date.UTC(2028, 1, 29));
    expect(readTimestamp('2026-09-01T00:00:00.5Z')).toBe(Date.UTC(2026, 8, 1) + 500);
  });
});
