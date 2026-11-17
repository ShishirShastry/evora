import { currentAuth, type Auth } from './account';
import {
  API_BASE,
  type AuthProviders,
  type AuthResult,
  type DocInfo,
  type GuestResult,
  type LinkAccess,
  type Member,
  type Notification,
  type PendingInvite,
  type Register,
  type Role,
  type StoredRegister,
  type Thread,
  type User,
  type UserRef,
  type Workspace,
} from './protocol';

/**
 * A typed client for every endpoint of the collaboration server's HTTP API
 * (the list is in `protocol.ts`). Each request carries the signed-in
 * account's session (`Authorization: Bearer …`) or, for someone without an
 * account, their guest token (`X-Evora-Guest`). A failed request throws an
 * `ApiError` with the server's own message.
 */

export class ApiError extends Error {
  /** The HTTP status, or 0 when the server could not be reached at all. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface ApiOptions {
  /** The fetch to use; the browser's own by default. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Where the API is; `/api` on the page's own origin by default. */
  base?: string;
  /** The credentials to send, asked for on every request; the account and guest kept on this device by default. */
  auth?: () => Auth;
}

export interface MembersResult {
  members: Member[];
  pending: PendingInvite[];
}

export interface InviteInfo {
  workspace: { id: string; name: string };
  role: Role;
  from: UserRef;
}

export interface Asset {
  mimeType: string;
  bytes: ArrayBuffer;
}

const id = (value: string): string => encodeURIComponent(value);

export function createApi(options: ApiOptions = {}) {
  const base = options.base ?? API_BASE;
  const auth = options.auth ?? currentAuth;
  // The browser's fetch must be called as a method of the window, so it is looked up on each call.
  const send = (input: string, init: RequestInit): Promise<Response> => (options.fetch ? options.fetch(input, init) : globalThis.fetch(input, init));

  function headersFor(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    const { token, guestToken } = auth();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (guestToken) headers['X-Evora-Guest'] = guestToken;
    return headers;
  }

  async function raw(method: string, path: string, init: { body?: BodyInit; contentType?: string } = {}): Promise<Response> {
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: headersFor(init.contentType ? { 'Content-Type': init.contentType } : {}),
        body: init.body,
      });
    } catch {
      throw new ApiError('The collaboration server could not be reached. Check that it is running and that you are online.', 0);
    }
    if (!response.ok) {
      let message = `The collaboration server answered with an error (${response.status}).`;
      try {
        const data = (await response.json()) as { error?: unknown };
        if (typeof data.error === 'string' && data.error) message = data.error;
      } catch {
        // Not JSON: the status says what there is to say.
      }
      throw new ApiError(message, response.status);
    }
    return response;
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await raw(method, path, body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' });
    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError('The collaboration server sent an answer that could not be read.', response.status);
    }
  }

  return {
    // ------------------------------------------------------------ accounts
    /** Creates an account (free, with no limits). A pending invite for that address is taken up. */
    signup: (email: string, name: string, password: string) => json<AuthResult>('POST', '/auth/signup', { email, name, password }),
    login: (email: string, password: string) => json<AuthResult>('POST', '/auth/login', { email, password }),
    logout: () => json<Record<string, never>>('POST', '/auth/logout'),
    /** An identity for someone without an account who opened a shared link. */
    createGuest: (name: string) => json<GuestResult>('POST', '/guests', { name }),
    me: () => json<{ user: User; workspaces: Workspace[] }>('GET', '/me'),
    updateMe: (changes: { name?: string; password?: string; color?: string }) => json<User>('PATCH', '/me', changes),
    /** The other ways of signing in the server offers (Google, when it is set up there). */
    authProviders: () => json<AuthProviders>('GET', '/auth/providers'),
    /** Trades the one-time ticket from coming back from Google for a session. */
    redeemGoogle: (ticket: string) => json<AuthResult>('POST', '/auth/google/redeem', { ticket }),

    // ------------------------------------------------------------ workspaces
    listWorkspaces: () => json<Workspace[]>('GET', '/workspaces'),
    createWorkspace: (name: string) => json<Workspace>('POST', '/workspaces', { name }),
    renameWorkspace: (workspaceId: string, name: string) => json<Workspace>('PATCH', `/workspaces/${id(workspaceId)}`, { name }),
    deleteWorkspace: (workspaceId: string) => json<Record<string, never>>('DELETE', `/workspaces/${id(workspaceId)}`),
    workspaceMembers: (workspaceId: string) => json<MembersResult>('GET', `/workspaces/${id(workspaceId)}/members`),
    addWorkspaceMember: (workspaceId: string, email: string, role: Role) => json<MembersResult>('POST', `/workspaces/${id(workspaceId)}/members`, { email, role }),
    setWorkspaceMemberRole: (workspaceId: string, userId: string, role: Role) =>
      json<MembersResult>('PATCH', `/workspaces/${id(workspaceId)}/members/${id(userId)}`, { role }),
    /** Removes a member, or with one's own ID leaves the workspace. */
    removeWorkspaceMember: (workspaceId: string, userId: string) => json<Record<string, never>>('DELETE', `/workspaces/${id(workspaceId)}/members/${id(userId)}`),
    /** Makes an invite link (`#/invite/<token>`) that gives whoever follows it this role. */
    createInviteLink: (workspaceId: string, role: Role) => json<{ token: string }>('POST', `/workspaces/${id(workspaceId)}/invites`, { role }),
    getInvite: (token: string) => json<InviteInfo>('GET', `/invites/${id(token)}`),
    acceptInvite: (token: string) => json<Workspace>('POST', `/invites/${id(token)}/accept`),
    workspaceDocuments: (workspaceId: string) => json<DocInfo[]>('GET', `/workspaces/${id(workspaceId)}/documents`),
    /** Documents shared with me directly, outside my workspaces. */
    sharedDocuments: () => json<DocInfo[]>('GET', '/shared'),

    // ------------------------------------------------------------ documents
    /** Creates a shared document, with `registers` as its starting content (e.g. a file from this device). */
    createDocument: (workspaceId: string, name: string, registers?: Register[]) =>
      json<DocInfo>('POST', '/documents', registers ? { workspaceId, name, registers } : { workspaceId, name }),
    getDocument: (docId: string) => json<DocInfo>('GET', `/documents/${id(docId)}`),
    updateDocument: (docId: string, changes: { name?: string; linkAccess?: LinkAccess }) => json<DocInfo>('PATCH', `/documents/${id(docId)}`, changes),
    deleteDocument: (docId: string) => json<Record<string, never>>('DELETE', `/documents/${id(docId)}`),
    documentMembers: (docId: string) => json<MembersResult>('GET', `/documents/${id(docId)}/members`),
    addDocumentMember: (docId: string, email: string, role: Role) => json<MembersResult>('POST', `/documents/${id(docId)}/members`, { email, role }),
    setDocumentMemberRole: (docId: string, userId: string, role: Role) => json<MembersResult>('PATCH', `/documents/${id(docId)}/members/${id(userId)}`, { role }),
    removeDocumentMember: (docId: string, userId: string) => json<Record<string, never>>('DELETE', `/documents/${id(docId)}/members/${id(userId)}`),
    /** The whole document as registers, with the server's sequence number. */
    documentRegisters: (docId: string) => json<{ seq: number; registers: StoredRegister[] }>('GET', `/documents/${id(docId)}/registers`),
    /** Uploads the bytes of an image the document uses, under their hash. */
    putAsset: async (docId: string, hash: string, bytes: ArrayBuffer | Uint8Array, mimeType: string): Promise<void> => {
      await raw('PUT', `/documents/${id(docId)}/assets/${id(hash)}`, { body: bytes as BodyInit, contentType: mimeType });
    },
    getAsset: async (docId: string, hash: string): Promise<Asset> => {
      const response = await raw('GET', `/documents/${id(docId)}/assets/${id(hash)}`);
      return { mimeType: response.headers.get('Content-Type') ?? 'application/octet-stream', bytes: await response.arrayBuffer() };
    },

    // ------------------------------------------------------------ comments
    listThreads: (docId: string) => json<Thread[]>('GET', `/documents/${id(docId)}/threads`),
    /** Starts a thread with its first comment, pinned at a place on a page (or on a layer). */
    createThread: (docId: string, pin: { pageId: string; x: number; y: number; nodeId: string | null }, body: string) =>
      json<Thread>('POST', `/documents/${id(docId)}/threads`, { ...pin, body }),
    reply: (threadId: string, body: string) => json<Thread>('POST', `/threads/${id(threadId)}/comments`, { body }),
    updateThread: (threadId: string, changes: { resolved?: boolean; x?: number; y?: number }) => json<Thread>('PATCH', `/threads/${id(threadId)}`, changes),
    deleteThread: (threadId: string) => json<Record<string, never>>('DELETE', `/threads/${id(threadId)}`),
    editComment: (commentId: string, body: string) => json<Thread>('PATCH', `/comments/${id(commentId)}`, { body }),
    /** Deletes a comment; answers with the thread, or with nothing when it was the thread's last comment. */
    deleteComment: async (commentId: string): Promise<Thread | null> => {
      const result = await json<Thread | Record<string, never>>('DELETE', `/comments/${id(commentId)}`);
      return 'id' in result ? (result as Thread) : null;
    },

    // ------------------------------------------------------------ notifications
    notifications: () => json<Notification[]>('GET', '/notifications'),
    markNotificationsRead: (ids: string[]) => json<Record<string, never>>('POST', '/notifications/read', { ids }),

    health: () => json<{ ok: true; version: string }>('GET', '/health'),
  };
}

export type EvoraApi = ReturnType<typeof createApi>;

/** The client the application uses: the page's own origin, with the identity kept on this device. */
export const api: EvoraApi = createApi();

/** A link that opens a shared document, to copy and send. */
export function documentLink(docId: string, origin: string = typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`): string {
  return `${origin}#/doc/${docId}`;
}

/** A link that invites whoever follows it into a workspace. */
export function inviteLink(token: string, origin: string = typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`): string {
  return `${origin}#/invite/${token}`;
}

/**
 * Where the window goes to sign in or up with Google: the server sends it on
 * to Google, and Google back to `origin` (the app's own address).
 */
export function googleStartUrl(origin: string, mode: 'login' | 'signup', invite?: string | null, base: string = API_BASE): string {
  const query = new URLSearchParams({ origin, mode });
  if (invite) query.set('invite', invite);
  return `${base}/auth/google/start?${query.toString()}`;
}

/** The message to show for something that failed. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
