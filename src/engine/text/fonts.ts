import { fontString, type Document } from '../../core';

/**
 * Loading fonts. Text is measured and painted on a canvas, and a canvas uses
 * a fallback font, silently, for a face the browser has not loaded yet. So
 * the faces a file needs are loaded before the file is shown, and whenever a
 * face arrives later (text in another script, say) everything that was
 * measured is measured again.
 */

/** The font family that ships with the application, so that text looks the same on every machine. */
export const BUNDLED_FONT_FAMILY = 'Inter';

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** A font, as a CSS font string, and characters that are set in it: together they say which faces are needed. */
export interface FontRequest {
  font: string;
  text: string;
}

/** Every face of the bundled font, for the Latin letters most text is made of. */
export function bundledFonts(): FontRequest[] {
  const requests: FontRequest[] = [];
  for (const italic of [false, true]) {
    for (const fontWeight of WEIGHTS) requests.push({ font: fontString({ fontFamily: BUNDLED_FONT_FAMILY, fontSize: 16, fontWeight, italic }), text: 'Hg' });
  }
  return requests;
}

/** The fonts a document's text is set in, each with the characters set in it. */
export function fontsUsedBy(doc: Document): FontRequest[] {
  const wanted = new Map<string, Set<string>>();
  const add = (fontFamily: string, fontWeight: number, italic: boolean, text: string): void => {
    const font = fontString({ fontFamily, fontSize: 16, fontWeight, italic });
    let characters = wanted.get(font);
    if (!characters) {
      characters = new Set();
      wanted.set(font, characters);
    }
    // The case setting can show capitals for small letters and the other way round.
    for (const char of text + text.toUpperCase() + text.toLowerCase()) if (char !== '\n') characters.add(char);
  };
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!node || node.type !== 'TEXT') continue;
    add(node.fontFamily, node.fontWeight, node.italic, node.characters);
    for (const range of node.styleRanges) {
      add(range.fontFamily ?? node.fontFamily, range.fontWeight ?? node.fontWeight, range.italic ?? node.italic, node.characters.slice(range.start, range.end));
    }
  }
  return [...wanted].map(([font, characters]) => ({ font, text: [...characters].join('') }));
}

/**
 * Asks the browser to load the faces these fonts need. Resolves once they are
 * loaded or have failed, or after `timeoutMs`, whichever is first; it never
 * rejects. Where there is no browser it resolves at once.
 */
export async function loadFonts(fonts: readonly FontRequest[], timeoutMs = 4000): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const loading = Promise.allSettled(fonts.map((request) => document.fonts.load(request.font, request.text || 'Hg')));
  await Promise.race([loading, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

/**
 * Calls back whenever the browser has finished loading font faces: text that
 * was measured before may measure differently now. Returns a function that
 * stops it.
 */
export function onFontsLoaded(callback: () => void): () => void {
  if (typeof document === 'undefined' || !document.fonts) return () => undefined;
  const handler = (event: Event): void => {
    const faces = (event as FontFaceSetLoadEvent).fontfaces;
    if (!faces || faces.length > 0) callback();
  };
  document.fonts.addEventListener('loadingdone', handler);
  return () => document.fonts.removeEventListener('loadingdone', handler);
}
