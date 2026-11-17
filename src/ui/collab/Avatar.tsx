import { initialsOf } from '../../collab/account';

/** Dark or white lettering, whichever reads better on a person's colour. */
export function inkOn(color: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return '#ffffff';
  const value = parseInt(match[1] as string, 16);
  const channel = (shift: number): number => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.36 ? '#111114' : '#ffffff';
}

interface AvatarProps {
  name: string;
  color: string;
  size?: number;
  /** A ring in the panel's colour, so avatars stacked over each other stay apart. */
  ring?: boolean;
  className?: string;
}

/** A person's avatar: their initials on their own colour. Decorative: whatever holds it names the person. */
export function Avatar({ name, color, size = 24, ring = false, className = '' }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex flex-none select-none items-center justify-center rounded-full font-semibold leading-none ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.4)),
        background: color,
        color: inkOn(color),
        boxShadow: ring ? '0 0 0 2px var(--ev-panel)' : 'inset 0 1px 0 rgba(255, 255, 255, 0.25)',
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
