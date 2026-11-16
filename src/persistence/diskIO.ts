import { FILE_EXTENSION } from '../core';

/** Reading and writing `.opendesign` files on the user's disk from the browser. */

interface PickerWindow {
  showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> }>;
  showOpenFilePicker?: (options: unknown) => Promise<{ getFile(): Promise<File> }[]>;
}

const PICKER_TYPES = [{ description: 'OPEN DESIGN file', accept: { 'application/json': [FILE_EXTENSION] } }];

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Saves text to a file the user chooses. Uses the native save dialog where the
 * browser has one and falls back to a download. Returns false if the user
 * cancelled.
 */
export async function saveTextToDisk(fileName: string, text: string): Promise<boolean> {
  const picker = (window as unknown as PickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker.call(window, { suggestedName: fileName, types: PICKER_TYPES });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return true;
    } catch (error) {
      if (isAbort(error)) return false;
      // Fall through to a plain download if the picker is not usable here.
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Lets the user choose image files. Returns an empty list if they cancelled. */
export function pickImageFiles(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Lets the user choose one file of the given kinds (an `accept` list). Null if they cancelled. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Lets the user choose a file and returns its text, or null if they cancelled. */
export async function pickTextFile(): Promise<string | null> {
  const picker = (window as unknown as PickerWindow).showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker.call(window, { types: PICKER_TYPES, multiple: false });
      return handle ? await (await handle.getFile()).text() : null;
    } catch (error) {
      if (isAbort(error)) return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${FILE_EXTENSION},application/json`;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) resolve(null);
      else file.text().then(resolve, () => resolve(null));
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
