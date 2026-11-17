// Bundles each example in plugins/examples/<name>/ (manifest.json, main.js
// and, for a plugin with a window, ui.html) into
// plugins/examples/<name>.evora-plugin, checking it with the same rules
// Evora installs with. Run it with Node 22.18 or later (which runs the
// TypeScript of the checks as it is):
//
//   node plugins/build-examples.mjs
//
// A plugin of your own is bundled the same way: see PLUGINS.md.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeBundle, serializeBundle } from '../src/plugins/manifest.ts';

/** The bundle of the plugin in a folder. */
export function bundleFolder(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const code = readFileSync(join(dir, manifest.main ?? 'main.js'), 'utf8');
  const ui = manifest.ui ? readFileSync(join(dir, manifest.ui), 'utf8') : null;
  return makeBundle(manifest, code, ui);
}

const root = join(import.meta.dirname, 'examples');
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const bundle = bundleFolder(dir);
    writeFileSync(join(root, `${name}.evora-plugin`), serializeBundle(bundle));
    console.log(`${name}.evora-plugin: ${bundle.manifest.name} ${bundle.manifest.version}`);
  }
}
