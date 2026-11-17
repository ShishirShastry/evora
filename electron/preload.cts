/**
 * The desktop app's preload: gives the app's pages `window.evoraDesktop`
 * (the contract is src/persistence/desktopContract.ts) and nothing else. It
 * runs sandboxed, with context isolation, so it cannot load other files: the
 * channel names are written out here and checked against the contract's by
 * the type checker.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { CHANNELS as Channels, EvoraDesktop } from '../src/persistence/desktopContract.js';

const CHANNELS = {
  info: 'evora:info',
  openDialog: 'evora:open-dialog',
  readPath: 'evora:read-path',
  openDropped: 'evora:open-dropped',
  save: 'evora:save',
  linkFor: 'evora:link-for',
  linkByPath: 'evora:link-by-path',
  setLink: 'evora:set-link',
  removeLink: 'evora:remove-link',
  writeRecovery: 'evora:write-recovery',
  clearRecovery: 'evora:clear-recovery',
  docState: 'evora:doc-state',
  nativeEdit: 'evora:native-edit',
  settings: 'evora:settings',
  setSettings: 'evora:set-settings',
  checkServer: 'evora:check-server',
  hostStatus: 'evora:host-status',
  startHost: 'evora:start-host',
  stopHost: 'evora:stop-host',
  checkUpdates: 'evora:check-updates',
  installUpdate: 'evora:install-update',
  openExternal: 'evora:open-external',
  openFile: 'evora:open-file',
  menu: 'evora:menu',
  prepareClose: 'evora:prepare-close',
  prepareCloseDone: 'evora:prepare-close-done',
  recover: 'evora:recover',
  hostChanged: 'evora:host-changed',
  updateChanged: 'evora:update-changed',
} as const satisfies typeof Channels;

function listen<T>(channel: string, callback: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => callback(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: EvoraDesktop = {
  info: () => ipcRenderer.invoke(CHANNELS.info),
  openDialog: () => ipcRenderer.invoke(CHANNELS.openDialog),
  readPath: (path) => ipcRenderer.invoke(CHANNELS.readPath, path),
  openDropped: async (file) => {
    // Only a File the person dropped has a path; one made by a page has none.
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke(CHANNELS.openDropped, path) : null;
  },
  save: (request) => ipcRenderer.invoke(CHANNELS.save, request),
  linkFor: (fileId) => ipcRenderer.invoke(CHANNELS.linkFor, fileId),
  linkByPath: (path) => ipcRenderer.invoke(CHANNELS.linkByPath, path),
  setLink: (link) => ipcRenderer.invoke(CHANNELS.setLink, link),
  removeLink: (fileId) => ipcRenderer.invoke(CHANNELS.removeLink, fileId),
  writeRecovery: (entry) => ipcRenderer.invoke(CHANNELS.writeRecovery, entry),
  clearRecovery: (fileId) => ipcRenderer.invoke(CHANNELS.clearRecovery, fileId),
  setDocState: (state) => ipcRenderer.send(CHANNELS.docState, state),
  nativeEdit: (action) => ipcRenderer.send(CHANNELS.nativeEdit, action),
  settings: () => ipcRenderer.invoke(CHANNELS.settings),
  setSettings: (patch) => ipcRenderer.invoke(CHANNELS.setSettings, patch),
  checkServer: (origin) => ipcRenderer.invoke(CHANNELS.checkServer, origin),
  hostStatus: () => ipcRenderer.invoke(CHANNELS.hostStatus),
  startHost: (port) => ipcRenderer.invoke(CHANNELS.startHost, port),
  stopHost: () => ipcRenderer.invoke(CHANNELS.stopHost),
  checkForUpdates: () => ipcRenderer.invoke(CHANNELS.checkUpdates),
  installUpdate: () => ipcRenderer.send(CHANNELS.installUpdate),
  openExternal: (url) => ipcRenderer.send(CHANNELS.openExternal, url),
  onOpenFile: (callback) => listen(CHANNELS.openFile, callback),
  onMenu: (callback) => listen(CHANNELS.menu, callback),
  onPrepareClose: (callback) =>
    listen<{ requestId: number; action: Parameters<typeof callback>[0] }>(CHANNELS.prepareClose, ({ requestId, action }) => {
      void callback(action).then(
        (ok) => ipcRenderer.send(CHANNELS.prepareCloseDone, { requestId, ok }),
        () => ipcRenderer.send(CHANNELS.prepareCloseDone, { requestId, ok: action !== 'save' }),
      );
    }),
  onRecover: (callback) => listen(CHANNELS.recover, callback),
  onHostStatus: (callback) => listen(CHANNELS.hostChanged, callback),
  onUpdateStatus: (callback) => listen(CHANNELS.updateChanged, callback),
};

contextBridge.exposeInMainWorld('evoraDesktop', bridge);
