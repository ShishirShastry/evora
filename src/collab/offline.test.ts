import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { OfflineStore } from './offline';
import { makeClock, type Register } from './protocol';

/** What a shared document leaves on this device: kept in IndexedDB, across reloads, per document. */

const reg = (k: string, v: unknown, ms: number): Register => ({ k, v, c: makeClock(ms, 0, 'me') });

describe('the offline store', () => {
  it('keeps a snapshot and the changes waiting, and gives them back after a reload', async () => {
    const factory = new IDBFactory();
    const first = new OfflineStore(factory);
    await first.save('doc1', { seq: 7, registers: [reg('n:A:x', 1, 100), reg('d:name', 'Shared', 100)], role: 'editor' }, [reg('n:A:x', 2, 200)]);
    await first.close();

    // A new store over the same database is what the next page load sees.
    const second = new OfflineStore(factory);
    const kept = await second.load('doc1');
    expect(kept?.snapshot).toMatchObject({ seq: 7, role: 'editor', registers: [reg('n:A:x', 1, 100), reg('d:name', 'Shared', 100)] });
    expect(typeof kept?.snapshot?.savedAt).toBe('string');
    expect(kept?.pending).toEqual([reg('n:A:x', 2, 200)]);
    await second.close();
  });

  it('writes the changes waiting on their own, without touching the snapshot', async () => {
    const store = new OfflineStore(new IDBFactory());
    await store.save('doc1', { seq: 3, registers: [reg('n:A:x', 1, 100)], role: null }, []);
    await store.savePending('doc1', [reg('n:A:y', 5, 300), reg('n:A:z', 6, 301)]);
    const kept = await store.load('doc1');
    expect(kept?.snapshot?.seq).toBe(3);
    expect(kept?.pending.map((register) => register.k)).toEqual(['n:A:y', 'n:A:z']);
    expect(await store.loadPending('doc1')).toHaveLength(2);
    // Changes made offline on a document never opened online are kept too.
    await store.savePending('doc2', [reg('n:B:x', 1, 400)]);
    expect((await store.load('doc2'))?.snapshot).toBeNull();
    expect(await store.documents()).toEqual(['doc1', 'doc2']);
  });

  it('keeps each document apart and forgets one when told', async () => {
    const store = new OfflineStore(new IDBFactory());
    await store.save('doc1', { seq: 1, registers: [reg('d:name', 'One', 1)], role: 'viewer' }, []);
    await store.save('doc2', { seq: 2, registers: [reg('d:name', 'Two', 1)], role: 'owner' }, [reg('d:name', 'Two!', 2)]);
    await store.clear('doc1');
    expect(await store.load('doc1')).toBeNull();
    expect((await store.load('doc2'))?.snapshot?.role).toBe('owner');
    expect(await store.loadPending('doc1')).toEqual([]);
  });

  it('keeps nothing, and fails nothing, without IndexedDB', async () => {
    const store = new OfflineStore(null);
    expect(await store.available()).toBe(false);
    await store.save('doc1', { seq: 1, registers: [], role: null }, [reg('n:A:x', 1, 1)]);
    await store.savePending('doc1', []);
    await store.clear('doc1');
    expect(await store.load('doc1')).toBeNull();
    expect(await store.documents()).toEqual([]);
  });
});
