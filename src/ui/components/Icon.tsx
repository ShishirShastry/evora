import type { ReactNode } from 'react';

export type IconName =
  | 'move'
  | 'hand'
  | 'frame'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'polygon'
  | 'star'
  | 'eye'
  | 'eyeOff'
  | 'lock'
  | 'unlock'
  | 'chevronRight'
  | 'chevronDown'
  | 'plus'
  | 'minus'
  | 'undo'
  | 'redo'
  | 'menu'
  | 'trash'
  | 'close'
  | 'file'
  | 'more'
  | 'check';

const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** OPEN DESIGN's own icon set: simple 16px line icons drawn for this project. */
const PATHS: Record<IconName, ReactNode> = {
  move: <path {...s} d="M3.5 2.5l9 4.6-3.7 1.2-1.3 3.7z" />,
  hand: <path {...s} d="M5.5 8V3.8a1 1 0 0 1 2 0V7m0-3.7a1 1 0 0 1 2 0V7m0-2.6a1 1 0 0 1 2 0V9.5c0 2.5-1.6 4-3.9 4-1.7 0-2.6-.7-3.5-2.1L3 9.6c-.5-.9.6-1.7 1.3-1l1.2 1.2" />,
  frame: <path {...s} d="M5 2v12M11 2v12M2 5h12M2 11h12" />,
  rectangle: <rect {...s} x="2.5" y="3.5" width="11" height="9" rx="1" />,
  ellipse: <circle {...s} cx="8" cy="8" r="5.5" />,
  line: <path {...s} d="M3 13L13 3" />,
  polygon: <path {...s} d="M8 2.8l5.6 9.7H2.4z" />,
  star: <path {...s} d="M8 2.2l1.7 3.7 4 .5-3 2.7.8 4L8 11.1l-3.5 2 .8-4-3-2.7 4-.5z" />,
  eye: (
    <>
      <path {...s} d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle {...s} cx="8" cy="8" r="1.8" />
    </>
  ),
  eyeOff: <path {...s} d="M2.5 2.5l11 11M6.3 4a6 6 0 0 1 1.7-.3c4 0 6.5 4.3 6.5 4.3a11 11 0 0 1-2 2.5M9.9 11.9A6 6 0 0 1 8 12.3C4 12.3 1.5 8 1.5 8a11 11 0 0 1 2.6-3" />,
  lock: (
    <>
      <rect {...s} x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path {...s} d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect {...s} x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path {...s} d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" />
    </>
  ),
  chevronRight: <path {...s} d="M6 3.5L10.5 8 6 12.5" />,
  chevronDown: <path {...s} d="M3.5 6L8 10.5 12.5 6" />,
  plus: <path {...s} d="M8 3v10M3 8h10" />,
  minus: <path {...s} d="M3 8h10" />,
  undo: <path {...s} d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6M3 6.5L6 3.5M3 6.5l3 3" />,
  redo: <path {...s} d="M13 6.5H6.5a3.5 3.5 0 0 0 0 7H10M13 6.5l-3-3M13 6.5l-3 3" />,
  menu: <path {...s} d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  trash: <path {...s} d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  close: <path {...s} d="M4 4l8 8M12 4l-8 8" />,
  file: <path {...s} d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
    </>
  ),
  check: <path {...s} d="M3.5 8.5l3 3 6-7" />,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** The OPEN DESIGN mark: an open ring with a square set into the opening. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 6a10 10 0 1 0 10 10" fill="none" stroke="var(--od-accent)" strokeWidth="3.5" strokeLinecap="round" />
      <rect x="17" y="7" width="8" height="8" rx="1.5" fill="var(--od-ink)" />
    </svg>
  );
}
