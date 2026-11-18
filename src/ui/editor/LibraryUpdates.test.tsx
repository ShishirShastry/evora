// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibraryUpdates } from '../../collab/libraries';
import { createDocument } from '../../core';
import { MemoryStorage } from '../../persistence/storage';
import { createEditorStore } from '../../state/editorStore';
import { shouldCheckLibraries, useLibraryUpdateChecks } from './LibraryUpdates';

/**
 * When the editor looks for library updates: on opening, every few minutes,
 * and at once when the page is shown again or the computer is back online,
 * never for someone who may only view the file.
 */

const INTERVAL = 300_000;
const GAP = 30_000;

function setUp(readOnly = false) {
  const editor = createEditorStore(createDocument('Design'));
  editor.setState({ readOnly });
  const updates = createLibraryUpdates({ editor, storage: new MemoryStorage(), signedIn: () => false, declinedStore: null });
  const check = vi.spyOn(updates, 'check').mockResolvedValue(undefined);
  return { editor, updates, check };
}

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('shouldCheckLibraries', () => {
  const ready = { online: true, visible: true, canTake: true, sinceLast: Infinity, gap: GAP };
  it('looks only when online, shown, for someone who can take updates, and not again too soon', () => {
    expect(shouldCheckLibraries(ready)).toBe(true);
    expect(shouldCheckLibraries({ ...ready, online: false })).toBe(false);
    expect(shouldCheckLibraries({ ...ready, visible: false })).toBe(false);
    expect(shouldCheckLibraries({ ...ready, canTake: false })).toBe(false);
    expect(shouldCheckLibraries({ ...ready, sinceLast: GAP - 1 })).toBe(false);
  });
});

describe('useLibraryUpdateChecks', () => {
  it('looks on opening, every interval, and when the computer is back online or the page shown again', () => {
    const { updates, check } = setUp();
    const { unmount } = renderHook(() => useLibraryUpdateChecks(updates, INTERVAL, GAP));
    expect(check).toHaveBeenCalledTimes(1);

    // Back online at once: too soon after the last look.
    window.dispatchEvent(new Event('online'));
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(GAP);
    window.dispatchEvent(new Event('online'));
    expect(check).toHaveBeenCalledTimes(2);

    // Hidden while something was published, then shown again.
    vi.advanceTimersByTime(GAP);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(check).toHaveBeenCalledTimes(2);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(check).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(INTERVAL);
    expect(check).toHaveBeenCalledTimes(4);

    // Once closed, nothing more.
    unmount();
    vi.advanceTimersByTime(INTERVAL);
    window.dispatchEvent(new Event('online'));
    expect(check).toHaveBeenCalledTimes(4);
  });

  it('never looks for someone who may only view the file', () => {
    const { updates, check } = setUp(true);
    renderHook(() => useLibraryUpdateChecks(updates, INTERVAL, GAP));
    vi.advanceTimersByTime(INTERVAL * 2);
    window.dispatchEvent(new Event('online'));
    expect(check).not.toHaveBeenCalled();
  });
});
