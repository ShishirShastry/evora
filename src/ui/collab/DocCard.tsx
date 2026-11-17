import { useState } from 'react';
import type { DocInfo } from '../../collab/protocol';
import { TextEdit } from '../components/Fields';
import { Icon } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { Avatar } from './Avatar';
import { timeAgo } from './hooks';

/** The hues a card's thumbnail is lit with, as for the files on this device. */
const HUES = [211, 258, 326, 18, 160, 190, 42];

function hueOf(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return HUES[Math.abs(hash) % HUES.length] ?? 211;
}

interface DocGridProps {
  docs: DocInfo[];
  onOpen: (doc: DocInfo) => void;
  /** The actions of a card's menu. */
  menuFor: (doc: DocInfo, rename: () => void) => MenuItem[];
  onRename: (doc: DocInfo, name: string) => void;
  label: string;
}

/** Shared documents as cards, like the files on this device, with the owner's avatar on each. */
export function DocGrid({ docs, onOpen, menuFor, onRename, label }: DocGridProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const now = Date.now();
  const openMenu = (doc: DocInfo, x: number, y: number): void => setMenu({ x, y, items: menuFor(doc, () => setRenaming(doc.id)) });

  return (
    <>
      <ul aria-label={label} className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-4 p-0">
        {docs.map((doc) => {
          const hue = hueOf(doc.id);
          const initial = Array.from(doc.name.trim())[0]?.toUpperCase() ?? '';
          return (
            <li
              key={doc.id}
              className="group relative flex flex-col rounded-[12px] bg-panel shadow-[var(--ev-shadow-panel)] transition-[translate,box-shadow] duration-150 ease-[var(--ev-ease)] hover:-translate-y-0.5 hover:shadow-[var(--ev-shadow-pop)]"
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(doc, event.clientX, event.clientY);
              }}
            >
              <div
                aria-hidden="true"
                className="relative m-1.5 mb-0 flex aspect-[16/10] items-center justify-center overflow-hidden rounded-[9px] bg-field shadow-[var(--ev-sunk)]"
                style={{
                  backgroundImage: `radial-gradient(90% 80% at 50% 115%, hsl(${hue} 90% 58% / 0.26), transparent 70%), radial-gradient(rgba(127, 127, 140, 0.16) 1px, transparent 1.3px)`,
                  backgroundSize: '100% 100%, 14px 14px',
                }}
              >
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-[14px] text-[20px] font-semibold text-accent-ink transition-transform duration-200 ease-[var(--ev-ease)] group-hover:-translate-y-0.5 group-hover:scale-105"
                  style={{
                    background: `linear-gradient(160deg, hsl(${hue} 92% 66%) 0%, hsl(${hue} 80% 47%) 100%)`,
                    boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 0 0 1px hsl(${hue} 70% 28% / 0.45), 0 10px 24px -10px hsl(${hue} 90% 50% / 0.85)`,
                  }}
                >
                  {initial}
                </span>
                <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-elevated/90 px-1.5 py-0.5 text-[10.5px] text-dim shadow-[var(--ev-raise)]">
                  <Icon name="users" size={11} />
                  Shared
                </span>
              </div>
              <div className="flex min-h-[50px] items-center gap-1 py-1.5 pl-3 pr-1.5">
                {renaming === doc.id ? (
                  <div className="min-w-0 flex-1">
                    <TextEdit
                      className="!h-7"
                      label="File name"
                      value={doc.name}
                      onCancel={() => setRenaming(null)}
                      onCommit={(name) => {
                        setRenaming(null);
                        if (name.trim() && name.trim() !== doc.name) onRename(doc, name.trim());
                      }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer flex-col items-start justify-center gap-0.5 border-0 bg-transparent p-0 text-left after:absolute after:inset-0 after:rounded-[12px] after:transition-shadow after:duration-150 focus-visible:!outline-none focus-visible:after:shadow-[0_0_0_2px_var(--ev-ring)]"
                    aria-label={`Open ${doc.name}`}
                    onClick={() => onOpen(doc)}
                  >
                    <span className="max-w-full truncate text-[12.5px] font-medium text-ink">{doc.name}</span>
                    <span className="flex max-w-full items-center gap-1 truncate text-[11px] text-dim">
                      <Avatar name={doc.owner.name} color={doc.owner.color} size={14} />
                      Edited {timeAgo(doc.updatedAt, now)}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="ev-icon-button relative z-10"
                  aria-label={`More actions for ${doc.name}`}
                  title="More actions"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenu(doc, rect.right - 200, rect.bottom + 4);
                  }}
                >
                  <Icon name="more" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="File menu" onClose={() => setMenu(null)} />}
    </>
  );
}
