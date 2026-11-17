import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the app's own files are: the project folder in development, the
 * package's archive (resources/app.asar) when installed. Found from this
 * file's place (dist-electron/electron/), since `app.getAppPath()` is the
 * script's folder when Electron is started with a script.
 */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The same, for files left outside the archive (asarUnpack), which plain Node must read. */
export const UNPACKED_ROOT = APP_ROOT.endsWith('.asar') ? `${APP_ROOT}.unpacked` : APP_ROOT;
