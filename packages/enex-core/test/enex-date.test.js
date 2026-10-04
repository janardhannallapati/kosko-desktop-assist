// formatEnexDate: the local database's epoch milliseconds, written the way an ENEX export writes <created>.
import { describe, it, expect } from 'vitest';
import { formatEnexDate } from '../src/enex/enex-date.js';
import { fingerprintNote } from '../src/fingerprint.js';

describe('formatEnexDate', () => {
  it('writes UTC as YYYYMMDDTHHMMSSZ', () => {
    expect(formatEnexDate(Date.UTC(2020, 0, 2, 3, 4, 5))).toBe('20200102T030405Z');
  });
  it('pads every field and keeps a pre-1970 date', () => {
    expect(formatEnexDate(Date.UTC(1969, 11, 31, 23, 59, 9))).toBe('19691231T235909Z');
  });
  it('refuses a value that is not a time', () => {
    expect(formatEnexDate(undefined)).toBeNull();
    expect(formatEnexDate(Number.NaN)).toBeNull();
  });
  it('gives the same fp1 identity as the ENEX string it stands for', async () => {
    const ms = Date.UTC(2017, 6, 9, 14, 30, 0);
    const local = await fingerprintNote({ created: formatEnexDate(ms) });
    const enex = await fingerprintNote({ created: '20170709T143000Z' });
    expect(local.identity).toBe(enex.identity);
  });
});
