import { createDocument, type Document } from '../../core';
import type { EvoraApi } from '../../collab/api';
import { makeClock, newClientId, type ClockState } from '../../collab/protocol';
import { registersFromDocument } from '../../collab/registers';
import type { DocumentStorage } from '../../persistence/storage';

/**
 * Putting a document on the collaboration server: its content as registers
 * (the shared form of a document), then the bytes of every image it uses.
 * Answers with the new shared document's ID.
 */
export async function uploadDocument(api: EvoraApi, storage: DocumentStorage | null, doc: Document, workspaceId: string): Promise<string> {
  // A clock of its own for the starting content: every later change, here or anywhere, is later than it.
  const clock: ClockState = { last: makeClock(0, 0, ''), clientId: newClientId() };
  const registers = registersFromDocument(doc, clock);
  const info = await api.createDocument(workspaceId, doc.name, registers);
  if (storage) {
    for (const hash of Object.keys(doc.assets)) {
      const asset = await storage.loadAsset(hash);
      if (asset) await api.putAsset(info.id, hash, asset.bytes, asset.mimeType);
    }
  }
  return info.id;
}

/** A new, empty shared document in a workspace (one empty page, as a new file on this device has). */
export function newSharedDocument(api: EvoraApi, workspaceId: string, name = 'Untitled'): Promise<string> {
  return uploadDocument(api, null, createDocument(name), workspaceId);
}
