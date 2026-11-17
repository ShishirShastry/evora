/**
 * `npm run desktop`: the desktop app in development. Starts Vite's
 * development server (port 5173, which passes /api and /ws to the
 * collaboration server at EVORA_SERVER or localhost:8787, as `npm run dev`
 * does), compiles the main process and preload, and opens Electron on it.
 * Closing the app stops Vite.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.EVORA_DEV_PORT ?? 5173);
const url = `http://localhost:${PORT}`;

const compile = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'electron', 'tsconfig.json')], { stdio: 'inherit' });
if (compile.status !== 0) process.exit(compile.status ?? 1);

const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'inherit' });

async function waitForVite() {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite did not start on ${url}`);
}

function stop(code) {
  if (!vite.killed) vite.kill();
  process.exit(code);
}

try {
  await waitForVite();
} catch (error) {
  console.error(error.message);
  stop(1);
}

const electron = require('electron'); // the path of the Electron binary
const app = spawn(electron, [root, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, EVORA_DEV_URL: url } });
app.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => {
  app.kill();
  stop(130);
});
