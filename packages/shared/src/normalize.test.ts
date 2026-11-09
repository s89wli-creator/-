import { describe, expect, it } from 'vitest';
import { normalizeArabic, normalizeCompanyName, normalizeCr, normalizeDomain, normalizePhone, normalizeVat } from './normalize';

describe('normalizeArabic', () => {
  it('unifies alef/ya/ta marbuta forms, removes tashkeel/tatweel, converts digits', () => {
    expect(normalizeArabic('مُؤسَّسةُ الإنجازِ ـــ ٢٠٢٤')).toBe('موسسه الانجاز 2024');
    expect(normalizeArabic('مستشفى')).toBe(normalizeArabic('مستشفي'));
  });
});

describe('normalizeCompanyName', () => {
  it('treats legal-form variants as the same company', () => {
    const a = normalizeCompanyName('شركة النقل السريع المحدودة');
    expect(normalizeCompanyName('مؤسسة النقل السريع')).toBe(a);
    expect(normalizeCompanyName('النقل السريع ذ.م.م')).toBe(a);
    expect(a).toBe('النقل السريع');
  });
  it('handles english legal suffixes', () => {
    expect(normalizeCompanyName('Fast Logistics Co. Ltd')).toBe('fast logistics');
  });
  it('never returns empty for a name made only of stopwords', () => {
    expect(normalizeCompanyName('شركة')).toBe('شركه');
  });
});

describe('normalizePhone', () => {
  it.each([
    ['0501234567', '+966501234567'],
    ['٠٥٠١٢٣٤٥٦٧', '+966501234567'],
    ['+966 50 123 4567', '+966501234567'],
    ['00966501234567', '+966501234567'],
    ['501234567', '+966501234567'],
    ['0114567890', '+966114567890'],
    ['920012345', '920012345'],
    ['+971501234567', '+971501234567'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
  it.each(['', 'abc', '123', '05012'])('rejects %s', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe('identifiers', () => {
  it('domain', () => {
    expect(normalizeDomain('https://www.Anjzni.com/about')).toBe('anjzni.com');
    expect(normalizeDomain('anjzni.com')).toBe('anjzni.com');
    expect(normalizeDomain('not a domain')).toBeNull();
  });
  it('CR and VAT', () => {
    expect(normalizeCr('١٠١٠١٢٣٤٥٦')).toBe('1010123456');
    expect(normalizeCr('123')).toBeNull();
    expect(normalizeVat('300000000000003')).toBe('300000000000003');
    expect(normalizeVat('100000000000003')).toBeNull();
  });
});
