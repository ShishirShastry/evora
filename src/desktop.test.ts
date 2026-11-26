import { describe, expect, it } from 'vitest';
import { appFilePath, contentType } from '../electron/staticFiles';
import { menuSpec, toAccelerator, type CommandItem } from '../electron/menuSpec';
import { macDownloadUrl, signedWithDeveloperId } from '../electron/updateNotice';
import { documentLink, inviteLink } from './collab/api';
import { configuredSocketUrl, linkOrigin, setServerOrigin } from './collab/endpoint';
import { createDocument, serializeFile, toFile } from './core';
import { diskBaseline, isDiskDirty, openDiskFile, saveToDisk, UnsupportedFileError } from './persistence/desktop';
import { canSaveInPlace, desktopCsp, diskFileKind, normalizeServerUrl, socketUrlFor, type DiskFile, type DiskLink, type SaveRequest } from './persistence/desktopContract';
import { openFile } from './persistence/files';
import { MemoryStorage } from './persistence/storage';
import { COMMANDS } from './state/commands';

/**
 * The desktop app's logic that runs without Electron: which files it opens,
 * the links between library files and files on disk, Save and Save as, the
 * collaboration server's address, the menus against the app's commands, and
 * the files its protocol serves. The app itself is tested in e2e/desktop.spec.ts.
 */

const encoder = new TextEncoder();

function evoraFile(name: string): { text: string; bytes: Uint8Array } {
  const now = '2026-11-01T00:00:00.000Z';
  const text = serializeFile(toFile(createDocument(name), { createdAt: now, updatedAt: now }));
  return { text, bytes: encoder.encode(text) };
}

function disk(path: string, bytes: Uint8Array, mtimeMs = 1000): DiskFile {
  return { path, name: path.split('/').pop() as string, bytes, mtimeMs };
}

/** The desktop app's side, as the tests need it: links kept in memory, Save answered without a dialog. */
function fakeBridge(dialogPath: string | null = '/chosen/Picked.evora') {
  const links = new Map<string, DiskLink>();
  const saved: SaveRequest[] = [];
  const cleared: string[] = [];
  return {
    links,
    saved,
    cleared,
    linkByPath: async (path: string) => [...links.values()].find((link) => link.path === path) ?? null,
    linkFor: async (fileId: string) => links.get(fileId) ?? null,
    setLink: async (link: DiskLink) => {
      for (const [id, other] of links) if (other.path === link.path) links.delete(id);
      links.set(link.fileId, link);
    },
    clearRecovery: async (fileId: string) => {
      cleared.push(fileId);
    },
    save: async (request: SaveRequest) => {
      saved.push(request);
      const path = request.path ?? dialogPath;
      return path ? { path, mtimeMs: 5000 + saved.length } : null;
    },
  };
}

describe('the files the desktop app opens', () => {
  it('knows them by name', () => {
    expect(diskFileKind('a/Landing.evora')).toBe('evora');
    expect(diskFileKind('Old.OPENDESIGN')).toBe('evora');
    expect(diskFileKind('Design.fig')).toBe('fig');
    expect(diskFileKind('icon.svg')).toBe('svg');
    expect(diskFileKind('notes.txt')).toBeNull();
    expect(canSaveInPlace('C:/x/a.evora')).toBe(true);
    expect(canSaveInPlace('C:/x/a.opendesign')).toBe(false);
    expect(canSaveInPlace('C:/x/a.fig')).toBe(false);
  });
});

describe('opening a file from disk', () => {
  it('makes a library file linked to a .evora file, and opens the same one again while the disk file is unchanged', async () => {
    const storage = new MemoryStorage();
    const bridge = fakeBridge();
    const file = evoraFile('Landing');
    const first = await openDiskFile(storage, bridge, disk('/work/Landing.evora', file.bytes));
    expect(first.reused).toBe(false);
    const opened = await openFile(storage, first.id);
    expect(opened?.doc.name).toBe('Landing');
    const link = bridge.links.get(first.id);
    expect(link).toMatchObject({ path: '/work/Landing.evora', mtimeMs: 1000, savedUpdatedAt: opened?.meta.updatedAt });

    const again = await openDiskFile(storage, bridge, disk('/work/Landing.evora', file.bytes));
    expect(again).toMatchObject({ id: first.id, reused: true });

    // Changed on disk since: read afresh, and the path is linked to the new library file.
    const changed = await openDiskFile(storage, bridge, disk('/work/Landing.evora', file.bytes, 2000));
    expect(changed.reused).toBe(false);
    expect(changed.id).not.toBe(first.id);
    expect(bridge.links.has(first.id)).toBe(false);
    expect(bridge.links.get(changed.id)?.mtimeMs).toBe(2000);
  });

  it('does not link a .opendesign file (Save makes a .evora), and says what is wrong with a damaged one', async () => {
    const storage = new MemoryStorage();
    const bridge = fakeBridge();
    const old = await openDiskFile(storage, bridge, disk('/work/Old.opendesign', evoraFile('Old').bytes));
    expect(await openFile(storage, old.id)).not.toBeNull();
    expect(bridge.links.size).toBe(0);
    await expect(openDiskFile(storage, bridge, disk('/work/Broken.evora', encoder.encode('{ not json')))).rejects.toThrow(/not valid JSON/);
    await expect(openDiskFile(storage, bridge, disk('/work/Binary.evora', new Uint8Array([0xff, 0xfe, 0x00])))).rejects.toThrow(/damaged/);
    await expect(openDiskFile(storage, bridge, disk('/work/notes.txt', encoder.encode('hello')))).rejects.toBeInstanceOf(UnsupportedFileError);
  });

  it('makes a new file for an SVG, to be placed as layers', async () => {
    const storage = new MemoryStorage();
    const opened = await openDiskFile(storage, fakeBridge(), disk('/work/Arrow icon.svg', encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>')));
    expect((await openFile(storage, opened.id))?.doc.name).toBe('Arrow icon');
    expect(opened.svg?.name).toBe('Arrow icon.svg');
    expect(opened.svg?.type).toBe('image/svg+xml');
  });

  it('reports a .fig file that cannot be read', async () => {
    await expect(openDiskFile(new MemoryStorage(), fakeBridge(), disk('/work/Nope.fig', encoder.encode('not a figma file')))).rejects.toThrow();
  });
});

describe('saving to disk', () => {
  async function libraryFile(storage: MemoryStorage) {
    const opened = await openDiskFile(storage, fakeBridge(), disk('/elsewhere/x.opendesign', evoraFile('Poster').bytes));
    const file = await openFile(storage, opened.id);
    if (!file) throw new Error('missing');
    return { fileId: opened.id, doc: file.doc, meta: file.meta };
  }

  it('Save asks where for a file without a link, then writes to it in place; the recovery copy is let go', async () => {
    const storage = new MemoryStorage();
    const target = await libraryFile(storage);
    const bridge = fakeBridge('/work/Poster.evora');
    expect(await saveToDisk(storage, bridge, target, 'save')).toBe('/work/Poster.evora');
    expect(bridge.saved[0]).toMatchObject({ path: null, suggestedName: 'Poster.evora', kind: 'evora' });
    expect(JSON.parse(bridge.saved[0]?.data as string).document.name).toBe('Poster');
    expect(bridge.links.get(target.fileId)).toMatchObject({ path: '/work/Poster.evora', savedUpdatedAt: target.meta.updatedAt, mtimeMs: 5001 });
    expect(bridge.cleared).toEqual([target.fileId]);

    await saveToDisk(storage, bridge, target, 'save');
    expect(bridge.saved[1]?.path).toBe('/work/Poster.evora');
  });

  it('Save as always asks and moves the link; a copy leaves it; a cancelled dialog changes nothing', async () => {
    const storage = new MemoryStorage();
    const target = await libraryFile(storage);
    const bridge = fakeBridge('/work/Poster.evora');
    await saveToDisk(storage, bridge, target, 'save');
    const other = fakeBridge('/work/Copy.evora');
    other.links.set(target.fileId, bridge.links.get(target.fileId) as DiskLink);
    expect(await saveToDisk(storage, other, target, 'copy')).toBe('/work/Copy.evora');
    expect(other.saved[0]?.path).toBeNull();
    expect(other.links.get(target.fileId)?.path).toBe('/work/Poster.evora');
    expect(await saveToDisk(storage, other, target, 'saveAs')).toBe('/work/Copy.evora');
    expect(other.links.get(target.fileId)?.path).toBe('/work/Copy.evora');

    const cancelled = fakeBridge(null);
    expect(await saveToDisk(storage, cancelled, target, 'saveAs')).toBeNull();
    expect(cancelled.links.size).toBe(0);
  });

  it('knows when the disk file is behind the document', () => {
    const doc = createDocument('A');
    const meta = { createdAt: 'c', updatedAt: 'u1' };
    const link: DiskLink = { fileId: doc.id, path: '/a.evora', savedUpdatedAt: 'u1', mtimeMs: 1 };
    expect(isDiskDirty(null, null, doc)).toBe(false);
    const baseline = diskBaseline(link, meta, doc);
    expect(isDiskDirty(link, baseline, doc)).toBe(false);
    expect(isDiskDirty(link, baseline, { ...doc, name: 'B' })).toBe(true);
    // Undone back to what was saved: another object with the same content matches the disk again.
    const copy = JSON.parse(JSON.stringify(doc)) as typeof doc;
    expect(isDiskDirty(link, baseline, copy)).toBe(false);
    const page = Object.keys(doc.nodes)[0] as string;
    expect(isDiskDirty(link, baseline, { ...copy, nodes: { ...copy.nodes, [page]: { ...copy.nodes[page], name: 'Moved' } as (typeof doc.nodes)[string] } })).toBe(true);
    // Changed in the library after the last save (for instance before a crash): behind from the start.
    expect(diskBaseline(link, { ...meta, updatedAt: 'u2' }, doc)).toBeNull();
    expect(isDiskDirty(link, null, doc)).toBe(true);
  });
});

describe('the collaboration server in the desktop app', () => {
  it('reads an address as an origin', () => {
    expect(normalizeServerUrl('192.168.1.20:8787')).toBe('http://192.168.1.20:8787');
    expect(normalizeServerUrl(' https://evora.example.com/ ')).toBe('https://evora.example.com');
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('ftp://host')).toBeNull();
    expect(normalizeServerUrl('http://host/path')).toBeNull();
    expect(normalizeServerUrl('http://user:secret@host')).toBeNull();
    expect(socketUrlFor('https://evora.example.com')).toBe('wss://evora.example.com/ws');
  });

  it('points the live connection and links at the configured server, and back at the page with none', () => {
    setServerOrigin('http://10.0.0.5:8787');
    try {
      expect(configuredSocketUrl()).toBe('ws://10.0.0.5:8787/ws');
      expect(linkOrigin()).toBe('http://10.0.0.5:8787/');
      expect(documentLink('d1')).toBe('http://10.0.0.5:8787/#/doc/d1');
      expect(inviteLink('t1')).toBe('http://10.0.0.5:8787/#/invite/t1');
    } finally {
      setServerOrigin(null);
    }
    expect(configuredSocketUrl()).toBeNull();
  });

  it('lets the pages reach only themselves and the configured server', () => {
    const none = desktopCsp(null);
    expect(none).toContain("default-src 'self'");
    expect(none).toContain("connect-src 'self' blob: data:;");
    expect(none).not.toContain('unsafe-eval');
    const withServer = desktopCsp('http://10.0.0.5:8787');
    expect(withServer).toContain('connect-src \'self\' blob: data: http://10.0.0.5:8787 ws://10.0.0.5:8787');
  });
});

describe('the native menus', () => {
  const commandItems = (platform: string): CommandItem[] =>
    menuSpec(platform).flatMap((menu) => menu.items.filter((item): item is CommandItem => item.kind === 'command'));

  it('writes the app’s shortcuts as Electron accelerators', () => {
    expect(toAccelerator('Ctrl+Shift+Z')).toBe('CmdOrCtrl+Shift+Z');
    expect(toAccelerator('Ctrl++')).toBe('CmdOrCtrl+Plus');
    expect(toAccelerator('Ctrl+-')).toBe('CmdOrCtrl+-');
    expect(toAccelerator("Ctrl+Alt+'")).toBe("CmdOrCtrl+Alt+'");
    expect(toAccelerator('Shift+1')).toBe('Shift+1');
    expect(toAccelerator('Esc')).toBe('Escape');
  });

  for (const platform of ['win32', 'darwin', 'linux']) {
    it(`runs the app's own commands, with their labels and shortcuts (${platform})`, () => {
      for (const item of commandItems(platform)) {
        if (item.id.startsWith('desktop.')) continue;
        const command = COMMANDS.find((candidate) => candidate.id === item.id);
        expect(command, item.id).toBeDefined();
        expect(item.label).toBe(command?.label);
        if (item.accelerator !== undefined) expect(item.accelerator).toBe(toAccelerator(command?.shortcut ?? ''));
        // On macOS a menu takes its keys from text fields: only shortcuts with ⌘ are given there.
        if (platform === 'darwin' && item.accelerator) expect(item.accelerator).toMatch(/CmdOrCtrl/);
      }
    });
  }

  it('has the File, Edit, View, Window and Help menus, and the app menu on macOS', () => {
    expect(menuSpec('win32').map((menu) => menu.label)).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    expect(menuSpec('darwin').map((menu) => menu.label)).toEqual(['Evora', 'File', 'Edit', 'View', 'Window', 'Help']);
    const desktop = commandItems('win32').filter((item) => item.id.startsWith('desktop.')).map((item) => item.id);
    expect(desktop).toEqual(['desktop.new', 'desktop.open', 'desktop.save', 'desktop.saveAs', 'desktop.saveFig', 'desktop.settings']);
  });
});

describe('the files app://evora serves', () => {
  it('names files inside the built app, and nothing outside it', () => {
    expect(appFilePath('/')).toBe('index.html');
    expect(appFilePath('')).toBe('index.html');
    expect(appFilePath('/assets/app.js')).toBe('assets/app.js');
    expect(appFilePath('//assets//app.js')).toBe('assets/app.js');
    expect(appFilePath('/../secret.txt')).toBeNull();
    expect(appFilePath('/assets/../../secret.txt')).toBeNull();
    expect(appFilePath('/%2e%2e/secret.txt')).toBeNull();
    expect(appFilePath('/..%5Csecret.txt')).toBeNull();
    expect(appFilePath('/C:%5Cwindows%5Cwin.ini')).toBeNull();
    expect(appFilePath('/c:/windows/win.ini')).toBeNull();
    expect(appFilePath('/a%00.js')).toBeNull();
    expect(appFilePath('/%E0%A4%A')).toBeNull();
    expect(contentType('assets/a.js')).toBe('text/javascript; charset=utf-8');
    expect(contentType('fonts/inter.woff2')).toBe('font/woff2');
    expect(contentType('index.html')).toBe('text/html; charset=utf-8');
    expect(contentType('README')).toBe('application/octet-stream');
  });
});

describe('a new version for a Mac copy that cannot update itself', () => {
  const RELEASES = 'https://github.com/ShishirShastry/evora/releases';
  // As latest-mac.yml of 0.2.0 lists them.
  const files = [{ url: 'Evora-0.3.0-mac-x64.zip' }, { url: 'Evora-0.3.0-mac-arm64.zip' }, { url: 'Evora-0.3.0-x64.dmg' }, { url: 'Evora-0.3.0-arm64.dmg' }];

  it('tells a Developer ID signature from an ad-hoc one, a development certificate or none', () => {
    const developerId = 'Executable=/Applications/Evora.app/Contents/MacOS/Evora\nIdentifier=org.evora.app\nAuthority=Developer ID Application: Someone (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=ABCDE12345';
    const adHoc = 'Executable=/Applications/Evora.app/Contents/MacOS/Evora\nIdentifier=org.evora.app\nCodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7\nSignature=adhoc\nTeamIdentifier=not set';
    const development = 'Identifier=org.evora.app\nAuthority=Apple Development: Someone (XYZ)\nAuthority=Apple Worldwide Developer Relations Certification Authority';
    expect(signedWithDeveloperId(developerId)).toBe(true);
    expect(signedWithDeveloperId(adHoc)).toBe(false);
    expect(signedWithDeveloperId(development)).toBe(false);
    expect(signedWithDeveloperId('/Applications/Evora.app: code object is not signed at all')).toBe(false);
    expect(signedWithDeveloperId('')).toBe(false);
  });

  it('offers the disk image for this Mac, or the release page when none fits', () => {
    expect(macDownloadUrl(RELEASES, '0.3.0', files, 'arm64')).toBe(`${RELEASES}/download/v0.3.0/Evora-0.3.0-arm64.dmg`);
    expect(macDownloadUrl(RELEASES, '0.3.0', files, 'x64')).toBe(`${RELEASES}/download/v0.3.0/Evora-0.3.0-x64.dmg`);
    // One disk image for every Mac.
    expect(macDownloadUrl(RELEASES, '0.3.0', [{ url: 'Evora-0.3.0-universal.dmg' }], 'arm64')).toBe(`${RELEASES}/download/v0.3.0/Evora-0.3.0-universal.dmg`);
    // Zips only, two images that are not for this Mac, nothing listed, or an address that is not https.
    expect(macDownloadUrl(RELEASES, '0.3.0', files.slice(0, 2), 'arm64')).toBe(`${RELEASES}/tag/v0.3.0`);
    expect(macDownloadUrl(RELEASES, '0.3.0', [{ url: 'a-ppc.dmg' }, { url: 'b-ia32.dmg' }], 'arm64')).toBe(`${RELEASES}/tag/v0.3.0`);
    expect(macDownloadUrl(RELEASES, '0.3.0', [], 'arm64')).toBe(`${RELEASES}/tag/v0.3.0`);
    expect(macDownloadUrl(RELEASES, '0.3.0', [{ url: 'http://example.com/Evora-arm64.dmg' }], 'arm64')).toBe(`${RELEASES}/tag/v0.3.0`);
  });
});
