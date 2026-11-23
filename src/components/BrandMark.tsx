import { useId } from 'react';

/** Folio's icon (src-tauri/icons/icon.svg) for use in the app. */
export function BrandMark({ size }: { size: number }) {
  // Gradient and filter ids must be unique when the mark shows more than once.
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} aria-hidden>
      <defs>
        <linearGradient id={`${id}bg`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#8b6ff9" />
          <stop offset="0.55" stopColor="#5a5ae8" />
          <stop offset="1" stopColor="#3341c0" />
        </linearGradient>
        <linearGradient id={`${id}gloss`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}flap`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#e6e4ff" />
          <stop offset="1" stopColor="#aeb2f7" />
        </linearGradient>
        <filter id={`${id}fold`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="-10" dy="14" stdDeviation="16" floodColor="#141850" floodOpacity="0.4" />
        </filter>
      </defs>
      <path d="M160 48H704L976 320V864a112 112 0 0 1-112 112H160A112 112 0 0 1 48 864V160A112 112 0 0 1 160 48z" fill={`url(#${id}bg)`} />
      <path d="M160 48H704L880 224C700 300 420 330 48 300V160A112 112 0 0 1 160 48z" fill={`url(#${id}gloss)`} />
      <path filter={`url(#${id}fold)`} d="M704 48V256a64 64 0 0 0 64 64H976z" fill={`url(#${id}flap)`} />
      <path d="M392 768V324H624M392 548H612" fill="none" stroke="#fff" strokeWidth="116" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
