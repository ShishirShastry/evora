/** Icons of version history and branching, drawn like the others in `components/Icon` (16 px, 1.25 strokes). */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** A branch: two lines leaving one. */
export function BranchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle {...stroke} cx="4.5" cy="3.5" r="1.5" />
      <circle {...stroke} cx="4.5" cy="12.5" r="1.5" />
      <circle {...stroke} cx="11.5" cy="5" r="1.5" />
      <path {...stroke} d="M4.5 5v6M11.5 6.5c0 2.5-2 3.5-7 4.5" />
    </svg>
  );
}

/** A conflict: two arrows meeting. */
export function ConflictIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path {...stroke} d="M2.5 4.5h6l-2-2M13.5 11.5h-6l2 2M8 7v2" />
    </svg>
  );
}

/** History: a clock with an arrow round it. */
export function HistoryIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path {...stroke} d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.5 2.5v2.3h2.3M8 5v3.2l2.2 1.4" />
    </svg>
  );
}
