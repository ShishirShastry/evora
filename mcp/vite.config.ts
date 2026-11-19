// Bundles the MCP server and the parts of Evora it uses into one file,
// dist-mcp/evora-mcp.mjs, that runs on Node.js 20 or later with nothing else
// installed: npm run mcp:build
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'mcp/main.ts',
    outDir: 'dist-mcp',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'evora-mcp.mjs', format: 'es', banner: '#!/usr/bin/env node' },
    },
  },
  ssr: { noExternal: true },
});
