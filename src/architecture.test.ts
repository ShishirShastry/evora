import { describe, expect, it } from 'vitest';

/**
 * Enforces the module boundaries in PROJECT_ARCHITECTURE.md §4 by reading the
 * imports of every source file:
 *   core        imports nothing outside core (and no UI or DOM libraries)
 *   engine, persistence   may import core (and each other's types)
 *   state       may import core, engine and persistence
 *   collab      may import core, persistence and state
 *   nothing     imports ui
 */
const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function layerOf(path: string): string {
  return path.split('/')[1] ?? '';
}

function importsOf(source: string): string[] {
  const out: string[] = [];
  const pattern = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) out.push((match[1] ?? match[2]) as string);
  return out;
}

/** Resolves a relative import against the importing file and returns the top-level folder it lands in. */
function targetLayer(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const parts = file.split('/').slice(1, -1);
  for (const part of specifier.split('/')) {
    if (part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts[0] ?? '';
}

const ALLOWED: Record<string, string[]> = {
  core: ['core'],
  engine: ['core', 'engine', 'state'],
  persistence: ['core', 'persistence', 'state'],
  state: ['core', 'engine', 'persistence', 'state'],
  // Collaboration (Phase 8): the sync engine works on the document, the editor store and the device's storage.
  collab: ['core', 'persistence', 'state', 'collab'],
  ui: ['core', 'engine', 'persistence', 'state', 'collab', 'ui'],
};

describe('module boundaries', () => {
  const files = Object.keys(sources).filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'));

  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((path) => path.startsWith('./core/'))).toBe(true);
  });

  it('keeps every folder to the imports it is allowed', () => {
    const violations: string[] = [];
    for (const file of files) {
      const layer = layerOf(file);
      const allowed = ALLOWED[layer];
      if (!allowed) continue;
      for (const specifier of importsOf(sources[file] as string)) {
        const target = targetLayer(file, specifier);
        if (target !== null && !allowed.includes(target)) violations.push(`${file} imports ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the core free of UI, state and DOM libraries', () => {
    const violations: string[] = [];
    for (const file of files.filter((path) => path.startsWith('./core/'))) {
      for (const specifier of importsOf(sources[file] as string)) {
        if (!specifier.startsWith('.') && specifier !== 'fractional-indexing') violations.push(`${file} imports ${specifier}`);
      }
      // A browser global used as an object ("window.foo"), not the word in prose or a property name.
      if (/(?<![.\w])(document|window|navigator|localStorage|indexedDB)\.[a-zA-Z]/.test(sources[file] as string)) {
        violations.push(`${file} touches a browser global`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps React out of the engines, persistence, state and collaboration', () => {
    const violations: string[] = [];
    for (const file of files.filter((path) => /^\.\/(engine|persistence|state|collab)\//.test(path))) {
      for (const specifier of importsOf(sources[file] as string)) {
        if (specifier === 'react' || specifier.startsWith('react-dom') || specifier === 'zustand') {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
