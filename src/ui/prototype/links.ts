import type { LinkAccess } from '../../collab/protocol';
import { prototypeFrames, startFrame, type Document, type NodeId } from '../../core';

/**
 * Prototype links: addresses that open a file straight into presentation
 * mode, from a chosen frame.
 *
 * A file on this device plays at `#/proto/<file>/<frame>`, which only works
 * in the browser that holds the file. A shared file (one on the
 * collaboration server) plays at `#/doc/<id>/present/<frame>`: that address
 * works for anyone the file's access lets open it, whatever device they are
 * on, so it is the one given to other people. These are the small, pure
 * pieces of that: making the address, reading it back, saying who can open
 * it, and what to tell someone it refuses.
 */

/** The address (after `#`) that presents a shared file, from a frame when one is named. */
export function presentHash(docId: string, startId?: string | null): string {
  return `#/doc/${encodeURIComponent(docId)}/present${startId ? `/${encodeURIComponent(startId)}` : ''}`;
}

/** The whole link that presents a shared file: `origin` is where links to this app start (`linkOrigin()`). */
export function prototypeLinkUrl(origin: string, docId: string, startId?: string | null): string {
  return `${origin}${presentHash(docId, startId)}`;
}

/** Reads `#/doc/<id>/present` or `#/doc/<id>/present/<frame>`; null for any other address. */
export function parsePresentHash(hash: string): { docId: string; startId?: string } | null {
  const match = /^#\/doc\/([0-9A-Za-z_-]+)\/present(?:\/([^/?#]+))?$/.exec(hash);
  if (!match) return null;
  const docId = match[1] as string;
  if (match[2] === undefined) return { docId };
  try {
    return { docId, startId: decodeURIComponent(match[2]) };
  } catch {
    // A frame that cannot be read is no frame: the presentation starts where it would without one.
    return { docId };
  }
}

/**
 * Where a presentation, or a prototype link, made from the editor starts:
 * the selected frame, or else the page's first flow or first frame. The same
 * for Present, and for every Copy prototype link (View menu, Prototype panel,
 * Share dialog).
 */
export function presentFrom(state: { doc: Document; pageId: NodeId; selection: readonly NodeId[] }): NodeId | null {
  const selected = state.selection.length === 1 ? state.selection[0] : undefined;
  const frames = prototypeFrames(state.doc, state.pageId);
  return selected !== undefined && frames.some((frame) => frame.id === selected) ? selected : startFrame(state.doc, state.pageId);
}

/**
 * Who a shared file's prototype link opens for, in a sentence. Null or
 * undefined is "not known yet" (the file's details have not loaded, or the
 * server cannot be reached), which claims neither way.
 */
export function audienceOf(linkAccess: LinkAccess | null | undefined): string {
  if (linkAccess === 'view' || linkAccess === 'edit') return 'Anyone with the link can open it, without an account.';
  if (linkAccess === null || linkAccess === undefined) return "It opens for anyone the file's access allows: see Share for who that is.";
  return 'Only people the file is shared with can open it. To let anyone with the link view it, change link access in Share.';
}

/** What "Copy prototype link" does for a file: give a link, or, for a file only on this device, ask for it to be shared first. */
export type PrototypeLinkPlan = { kind: 'link'; url: string; audience: string } | { kind: 'share-first'; reason: string };

/** Why a file on this device has no prototype link for others yet. */
export const SHARE_FIRST_REASON =
  'A prototype link only works for other people once the file is shared: this file is kept on this device. Share it into a workspace (free), then copy the prototype link again.';

export function planPrototypeLink(options: { sharedId: string | null; linkAccess?: LinkAccess | null; startId?: string | null; origin: string }): PrototypeLinkPlan {
  if (options.sharedId === null) return { kind: 'share-first', reason: SHARE_FIRST_REASON };
  return { kind: 'link', url: prototypeLinkUrl(options.origin, options.sharedId, options.startId), audience: audienceOf(options.linkAccess) };
}

/** What copying a prototype link needs from where it is done: the clipboard, and how to say what happened or to offer Share. */
export interface CopyPrototypeLinkDeps {
  /** Writes text to the clipboard; absent when the browser has no clipboard. */
  writeText?: (text: string) => Promise<void>;
  /** Says the link was copied (`copied` true), or shows it to be copied by hand (false), with who it opens for. */
  said: (url: string, audience: string, copied: boolean) => void;
  /** For a file on this device: offers sharing it, with why. */
  shareFirst: (reason: string) => void;
}

/**
 * "Copy prototype link", wherever it is pressed (the editor, its menu and
 * panel, or the presentation): the link is copied and said, or a file on
 * this device is offered Share instead. Resolves once it is done.
 */
export async function copyPrototypeLink(plan: PrototypeLinkPlan, deps: CopyPrototypeLinkDeps): Promise<void> {
  if (plan.kind === 'share-first') {
    deps.shareFirst(plan.reason);
    return;
  }
  let copied = false;
  if (deps.writeText) {
    try {
      await deps.writeText(plan.url);
      copied = true;
    } catch {
      // The browser refused: the link is shown to be copied by hand.
    }
  }
  deps.said(plan.url, plan.audience, copied);
}

/**
 * Going to the presentation once a shared file's changes are sent: one wait
 * at a time (pressing Present again while waiting does nothing), and no
 * going after `cancel` (the editor was closed meanwhile, so nobody is pulled
 * back into a file they left).
 *
 * `wait` may resolve with how many changes are still unsent. The
 * presentation holds no live connection, so changes left unsent then would
 * reach the server only when the file is next opened in the editor here:
 * given `warn`, the first such Present warns instead of going, and the next
 * one goes anyway (the person has been told).
 */
export function createPresentGate(): {
  start: (wait: Promise<number | void>, go: () => void, warn?: (unsent: number) => void) => boolean;
  cancel: () => void;
} {
  let waiting = false;
  let cancelled = false;
  let warned = false;
  return {
    start(wait, go, warn) {
      if (waiting || cancelled) return false;
      waiting = true;
      void wait.then((unsent) => {
        waiting = false;
        if (cancelled) return;
        const left = typeof unsent === 'number' ? unsent : 0;
        if (left > 0 && warn && !warned) {
          warned = true;
          warn(left);
          return;
        }
        warned = false;
        go();
      });
      return true;
    },
    cancel() {
      cancelled = true;
    },
  };
}

/** What Present says when a shared file's changes have not all reached the server after waiting for them. */
export function unsentWarning(unsent: number): string {
  const what = unsent === 1 ? '1 change has' : `${unsent} changes have`;
  return `${what} not reached the server yet. The presentation would show them, but they would be sent only when you open this file in the editor again. Wait for the connection, or press Present again to present anyway.`;
}

/** What a presentation the server refused says, and what the person can do about it. */
export interface RefusalNotice {
  title: string;
  detail: string;
  /** Whether signing in (or in with another account) could help. */
  offerSignIn: boolean;
}

/**
 * The message for a prototype link that could not be opened, by the
 * server's status (0 when it could not be reached) and who is asking.
 */
export function refusalNotice(status: number, who: { signedIn: boolean; name?: string | null }, message = ''): RefusalNotice {
  if (status === 401) {
    // A guest whose name the server no longer knows is asked for one again (the screen forgets it), so this is for an account.
    return { title: 'Sign in to view this prototype', detail: message || (who.signedIn ? 'Your sign-in has expired. Sign in again to open it.' : 'You need to sign in, or join as a guest, to open it.'), offerSignIn: true };
  }
  if (status === 403) {
    const as = who.signedIn ? (who.name ? `You are signed in as ${who.name}, who` : 'Your account') : 'As a guest you';
    return {
      title: 'You do not have access to this prototype',
      detail: `${as} cannot open this file. Ask the person who sent the link to share the file with you, or to let anyone with the link view it.${who.signedIn ? ' Or sign in with an account that has access.' : ' If you have an account with access, sign in.'}`,
      offerSignIn: true,
    };
  }
  if (status === 404) {
    return { title: 'This prototype link leads nowhere', detail: 'There is no such file on this server: the link may be mistyped, or the file deleted. Ask the person who sent it for a new link.', offerSignIn: false };
  }
  if (status === 410) {
    return { title: 'This file is in the trash', detail: message || 'Nobody can open it until someone who can edit its workspace restores it.', offerSignIn: false };
  }
  if (status === 0) {
    return { title: 'The prototype could not be opened', detail: message || 'The collaboration server cannot be reached. Check the connection and try again.', offerSignIn: false };
  }
  return { title: 'The prototype could not be opened', detail: message || 'The server could not open it. Try again.', offerSignIn: false };
}
