/**
 * Checks on the files in deploy/ and docs/self-hosting.md that can be made
 * without Docker: the image copies every file of src/ the server imports, and
 * the documentation lists every setting.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every project file that `entries` import, directly or not (with the extension written, as the server must). */
function importGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((entry) => resolve(root, entry));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const found of text.matchAll(/(?:import|export)\s[^'";]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = resolve(dirname(file), (found[1] ?? found[2]) as string);
      expect(existsSync(target), `${relative(root, file)} imports ${target}`).toBe(true);
      queue.push(target);
    }
  }
  return [...seen].map((file) => relative(root, file).split('\\').join('/')).sort();
}

describe('deploy/Dockerfile', () => {
  const dockerfile = readFileSync(resolve(root, 'deploy/Dockerfile'), 'utf8');

  it('copies every file of src/ that the server and the backup tool import', () => {
    const needed = importGraph(['server/main.ts', 'server/backup.ts']).filter((file) => file.startsWith('src/'));
    expect(needed.length).toBeGreaterThan(0);
    const copied = [...dockerfile.matchAll(/^COPY --from=build \/src\/(\S+) /gm)].map((found) => found[1] as string);
    for (const file of needed) expect(copied.some((path) => file === path || file.startsWith(`${path}/`)), `${file} is not copied into the image`).toBe(true);
  });

  it('runs as a user that is not root, keeps data in a volume and checks its health', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^VOLUME \["\/data"\]$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK .*\n.*\/api\/health/m);
    expect(dockerfile).toMatch(/^CMD \["node", "server\/main.ts"\]$/m);
  });
});

describe('docs/self-hosting.md', () => {
  it('lists every setting the server reads', () => {
    const config = readFileSync(resolve(root, 'server/config.ts'), 'utf8');
    const docs = readFileSync(resolve(root, 'docs/self-hosting.md'), 'utf8');
    const variables = new Set([...config.matchAll(/\bEVORA_[A-Z_]+\b/g)].map((found) => found[0]));
    const flags = new Set([...config.matchAll(/^\s+'?([a-z][a-z-]+)'?: \{ type: '(?:string|boolean)'/gm)].map((found) => `--${found[1]}`));
    expect(variables.size).toBeGreaterThan(8);
    expect(flags.size).toBeGreaterThan(8);
    for (const name of [...variables, ...flags]) expect(docs, `${name} is not in docs/self-hosting.md`).toContain(`\`${name}\``);
  });
});
