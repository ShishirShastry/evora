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
  | 'check'
  | 'group'
  | 'alignLeft'
  | 'alignCenterX'
  | 'alignRight'
  | 'alignTop'
  | 'alignCenterY'
  | 'alignBottom'
  | 'distributeH'
  | 'distributeV'
  | 'text'
  | 'textLeft'
  | 'textCenter'
  | 'textRight'
  | 'textTop'
  | 'textMiddle'
  | 'textBottom'
  | 'corners'
  | 'vector'
  | 'pen'
  | 'pencil'
  | 'union'
  | 'subtract'
  | 'intersect'
  | 'exclude';

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
  group: <path {...s} strokeDasharray="2 2" d="M2.5 2.5h11v11h-11z" />,
  alignLeft: <path {...s} d="M2.5 2v12M5 4.5h7v2.5H5zM5 9h4.5v2.5H5z" />,
  alignCenterX: <path {...s} d="M8 2v12M4 4.5h8v2.5H4zM5.5 9h5v2.5h-5z" />,
  alignRight: <path {...s} d="M13.5 2v12M4 4.5h7v2.5H4zM6.5 9H11v2.5H6.5z" />,
  alignTop: <path {...s} d="M2 2.5h12M4.5 5v7H7V5zM9 5v4.5h2.5V5z" />,
  alignCenterY: <path {...s} d="M2 8h12M4.5 4v8H7V4zM9 5.5v5h2.5v-5z" />,
  alignBottom: <path {...s} d="M2 13.5h12M4.5 4v7H7V4zM9 6.5V11h2.5V6.5z" />,
  distributeH: <path {...s} d="M2.5 2v12M13.5 2v12M6.5 4.5h3v7h-3z" />,
  distributeV: <path {...s} d="M2 2.5h12M2 13.5h12M4.5 6.5h7v3h-7z" />,
  text: <path {...s} d="M3.5 5V3.5h9V5M8 3.5v9M6.2 12.5h3.6" />,
  textLeft: <path {...s} d="M2.5 4h11M2.5 8h7M2.5 12h9" />,
  textCenter: <path {...s} d="M2.5 4h11M4.5 8h7M3.5 12h9" />,
  textRight: <path {...s} d="M2.5 4h11M6.5 8h7M4.5 12h9" />,
  textTop: <path {...s} d="M2.5 2.5h11M8 13.5V6M5.5 8.5L8 6l2.5 2.5" />,
  textMiddle: <path {...s} d="M2.5 8h11M8 2v3.5M6.3 4L8 5.5 9.7 4M8 14v-3.5M6.3 12L8 10.5 9.7 12" />,
  textBottom: <path {...s} d="M2.5 13.5h11M8 2.5V10M5.5 7.5L8 10l2.5-2.5" />,
  corners: <path {...s} d="M2.5 6V4.5a2 2 0 0 1 2-2H6M10 2.5h1.5a2 2 0 0 1 2 2V6M13.5 10v1.5a2 2 0 0 1-2 2H10M6 13.5H4.5a2 2 0 0 1-2-2V10" />,
  vector: (
    <>
      <path {...s} d="M3.5 11C3.5 5.5 12.5 10.5 12.5 5" />
      <rect {...s} x="2" y="11" width="3" height="3" />
      <rect {...s} x="11" y="2" width="3" height="3" />
    </>
  ),
  pen: <path {...s} d="M8 2l3.4 6.6-1.6 3.4H6.2L4.6 8.6zM8 2v5.6M5.5 14h5" />,
  pencil: <path {...s} d="M2.8 13.2l.8-3.2 7.2-7.2 2.4 2.4L6 12.4zM9.4 4.2l2.4 2.4" />,
  union: <path {...s} d="M2.5 2.5h7V6h4v7.5H6V10H2.5z" />,
  subtract: (
    <>
      <path {...s} d="M2.5 2.5h7V6H6v4H2.5z" />
      <path {...s} strokeDasharray="1.5 1.8" d="M9.5 6h4v7.5H6V10" />
    </>
  ),
  intersect: (
    <>
      <path {...s} d="M6 6h3.5v4H6z" />
      <path {...s} strokeDasharray="1.5 1.8" d="M6 6V2.5H2.5V10H6M9.5 6h4v7.5H6V10" />
    </>
  ),
  exclude: (
    <>
      <path {...s} d="M2.5 2.5h7V6H6v4H2.5z" />
      <path {...s} d="M9.5 6h4v7.5H6V10h3.5z" />
    </>
  ),
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
