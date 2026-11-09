/**
 * Arabic-aware normalization used for search and duplicate detection.
 * Same code runs in the API (stored in name_normalized) and in tests.
 */
const TASHKEEL = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC = /[٠-٩]/g;
const EASTERN_INDIC = /[۰-۹]/g;

/** Legal / generic company words removed before comparing names. */
const COMPANY_STOPWORDS = [
  'شركه', 'شركة', 'مؤسسه', 'مؤسسة', 'مجموعه', 'مجموعة', 'المحدوده', 'المحدودة', 'محدوده', 'محدودة',
  'ذات', 'مسؤوليه', 'مسؤولية', 'ذمم', 'للتجاره', 'للتجارة', 'التجاريه', 'التجارية',
  'co', 'company', 'corp', 'corporation', 'ltd', 'llc', 'est', 'establishment', 'group', 'inc', 'trading',
];

export function toLatinDigits(s: string): string {
  return s
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function normalizeArabic(input: string): string {
  return toLatinDigits(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Normalized company name for duplicate detection (legal suffixes and "ال" prefix noise removed). */
export function normalizeCompanyName(input: string): string {
  const stop = new Set(COMPANY_STOPWORDS.map(normalizeArabic));
  // Note: JS \b does not understand Arabic letters, so abbreviations are handled per token.
  const tokens = normalizeArabic(input).split(' ').filter(Boolean);
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'ذ' && tokens[i + 1] === 'م' && tokens[i + 2] === 'م') {
      i += 2; // "ذ.م.م" (limited liability)
      continue;
    }
    if (!stop.has(tokens[i]!)) words.push(tokens[i]!);
  }
  return words.join(' ') || normalizeArabic(input);
}

/**
 * Saudi phone numbers to E.164 (+966...). Returns null for values that cannot be a phone number.
 * Accepts 05XXXXXXXX, 5XXXXXXXX, 9665..., +9665..., 00966..., landlines 01X..., 800 / 920 numbers kept as digits.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = toLatinDigits(String(input)).replace(/[^\d+]/g, '');
  if (!d) return null;
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (/^(800|920)\d{6,7}$/.test(d)) return d; // toll-free / unified numbers
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (/^5\d{8}$/.test(d) || /^1\d{7,8}$/.test(d)) return `+966${d}`;
  // International number already in E.164 shape (not Saudi).
  const raw = toLatinDigits(String(input)).replace(/[^\d]/g, '');
  if (/^[1-9]\d{7,14}$/.test(raw) && String(input).trim().match(/^(\+|00)/)) return `+${raw.replace(/^00/, '')}`;
  return null;
}

/** Bare domain from a URL or domain-ish string ("https://www.Acme.sa/x" -> "acme.sa"). */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  try {
    const url = new URL(s.includes('://') ? s : `http://${s}`);
    const host = url.hostname.replace(/^www\./, '');
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** CR: 10 digits. Returns null if invalid. */
export function normalizeCr(input: string | null | undefined): string | null {
  if (!input) return null;
  const d = toLatinDigits(String(input)).replace(/\D/g, '');
  return /^\d{10}$/.test(d) ? d : null;
}

export function normalizeVat(input: string | null | undefined): string | null {
  if (!input) return null;
  const d = toLatinDigits(String(input)).replace(/\D/g, '');
  return /^3\d{13}3$/.test(d) ? d : null;
}
