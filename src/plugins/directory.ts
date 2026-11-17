/**
 * The plugin directory on the collaboration server (`server/plugins.ts`):
 * browsing and searching what others published, installing from it, and
 * publishing. Browsing needs no account; publishing does.
 */
import { currentAuth, type Auth } from '../collab/account';
import { API_BASE } from '../collab/protocol';
import { parseBundle, type PluginBundle, type PluginCommand, type Permission, type WidgetDeclaration } from './manifest';

export interface DirectoryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: 'plugin' | 'widget';
  author: { id: string; name: string };
  installs: number;
  updatedAt: string;
}

export interface DirectoryDetails extends DirectoryEntry {
  permissions: Permission[];
  commands: PluginCommand[];
  widgets: WidgetDeclaration[];
  versions: { version: string; notes: string; publishedAt: string }[];
}

export class DirectoryError extends Error {
  /** The HTTP status, or 0 when the server could not be reached. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DirectoryError';
    this.status = status;
  }
}

export interface DirectoryOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  base?: string;
  auth?: () => Auth;
}

export function createDirectory(options: DirectoryOptions = {}) {
  const base = options.base ?? API_BASE;
  const auth = options.auth ?? currentAuth;
  const send = (input: string, init: RequestInit): Promise<Response> => (options.fetch ? options.fetch(input, init) : globalThis.fetch(input, init));

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const { token, guestToken } = auth();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (guestToken) headers['X-Evora-Guest'] = guestToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await send(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new DirectoryError('The plugin directory could not be reached: it is on the collaboration server, which is not running or not reachable.', 0);
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // Not JSON.
    }
    if (!response.ok) {
      const error = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `The server answered with an error (${response.status}).`;
      throw new DirectoryError(error, response.status);
    }
    return data as T;
  }

  const id = encodeURIComponent;
  return {
    search: (q = '', kind: '' | 'plugin' | 'widget' = '') => json<DirectoryEntry[]>('GET', `/plugins/directory?q=${id(q)}&kind=${kind}`),
    details: (pluginId: string) => json<DirectoryDetails>('GET', `/plugins/directory/${id(pluginId)}`),
    /** The bundle to install (checked here as well), counted as an install. */
    install: async (pluginId: string, version?: string): Promise<PluginBundle> => {
      const answer = await json<{ bundle: unknown }>('POST', `/plugins/directory/${id(pluginId)}/install`, version ? { version } : {});
      return parseBundle(answer.bundle);
    },
    publish: (bundle: PluginBundle, notes?: string) => json<DirectoryEntry>('POST', '/plugins/directory', { bundle, ...(notes ? { notes } : {}) }),
    unpublish: (pluginId: string) => json<Record<string, never>>('DELETE', `/plugins/directory/${id(pluginId)}`),
  };
}

export type Directory = ReturnType<typeof createDirectory>;
