import { BRAND, LATIN, SYMBOL, WORDMARK } from './marks';

/** auto = follows the theme (petrol on light, reverse on dark and on petrol surfaces). */
type Tone = 'auto' | 'color' | 'reverse' | 'mono';

/**
 * Rakan logo system (identity guide 1.0):
 * - symbol: speech bubble + check + amber dot (app icon, favicon, compact spaces)
 * - wordmark: the drawn Arabic name — never replaced by typed text
 * - horizontal: symbol on the right of the wordmark (RTL reading order), optional Latin "RAKAN"
 * Tones: color (on light), reverse (on petrol), mono (single color, print/stamps).
 * Minimum symbol size 24px; clear space = 3 × the amber dot height.
 */
export function Symbol({ size = 40, tone = 'auto', className }: { size?: number; tone?: Tone; className?: string }) {
  const bubble = tone === 'auto' ? 'var(--logo-ink)' : tone === 'reverse' ? BRAND.white : tone === 'mono' ? 'currentColor' : BRAND.petrol;
  const check = tone === 'auto' ? 'var(--logo-check)' : tone === 'reverse' ? BRAND.petrol : BRAND.white;
  // Single-color version: the dot takes the check color (guide: لون واحد).
  const dot = tone === 'mono' ? check : BRAND.amber;
  return (
    <svg viewBox={SYMBOL.viewBox} width={size} height={(size * 204) / 192} className={className} aria-hidden focusable="false">
      <path d={SYMBOL.bubble} fill={bubble} />
      <path d={SYMBOL.check} fill={check} />
      <circle {...SYMBOL.dot} fill={dot} />
    </svg>
  );
}

export function Wordmark({ height = 28, tone = 'auto', latin = false, className }: { height?: number; tone?: Tone; latin?: boolean; className?: string }) {
  const ink = tone === 'auto' ? 'var(--logo-ink)' : tone === 'reverse' ? BRAND.white : tone === 'mono' ? 'currentColor' : BRAND.petrol;
  const dot = tone === 'mono' ? 'currentColor' : BRAND.amber;
  const vbHeight = latin ? 165 + 45 : 156; // Latin sits 165 units below the wordmark origin, as in the master artwork
  return (
    <svg viewBox={`0 0 450 ${vbHeight}`} height={height} width={(height * 450) / vbHeight} className={className} aria-hidden focusable="false">
      <path d={WORDMARK.path} fill={ink} fillRule="evenodd" />
      <circle {...WORDMARK.dot} fill={dot} />
      {latin && (
        <g transform="translate(0 165)">
          <path d={LATIN.path} fill={ink} fillRule="evenodd" />
        </g>
      )}
    </svg>
  );
}

/** Horizontal lockup. `label` is the accessible name (the marks themselves are decorative). */
export function Logo({ height = 32, tone = 'auto', latin = false, label = 'راكان', className }: { height?: number; tone?: Tone; latin?: boolean; label?: string; className?: string }) {
  return (
    <span role="img" aria-label={label} className={['inline-flex items-center gap-[0.35em]', className].filter(Boolean).join(' ')} dir="rtl" style={{ fontSize: height }}>
      <Symbol size={height * 0.94} tone={tone} />
      <Wordmark height={latin ? height * 1.1 : height * 0.82} tone={tone} latin={latin} />
    </span>
  );
}
