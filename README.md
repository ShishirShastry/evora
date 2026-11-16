# OPEN DESIGN

A free, open-source, local-first design and prototyping application. No account, no subscription, no paid features, no AI generation. The full specification is [OPEN_DESIGN_MASTER_SPEC.md](OPEN_DESIGN_MASTER_SPEC.md); the current state of the build is in [HANDOFF.md](HANDOFF.md).

## Run it

The project carries its own copy of Node.js in `.tools/` (not committed), so nothing needs to be installed. From PowerShell, in this folder:

```powershell
. .\scripts\env.ps1     # puts the bundled Node.js on PATH for this window
npm run dev             # starts the app at http://localhost:5173
```

If Node.js 20.19 or newer is already installed on the machine, skip the first line. On a fresh checkout run `npm install` once first.

## Check it

```powershell
npm run typecheck       # TypeScript, no errors allowed
npm test                # unit tests (Vitest)
npm run e2e             # acceptance tests in Microsoft Edge (Playwright)
npm run build           # production build into dist/
```

## Where things are

| Folder | What it holds |
|---|---|
| `src/core` | The document model and every operation on it. Pure TypeScript: no React, no browser APIs. |
| `src/engine` | Canvas renderer, selection overlay, viewport maths and the interaction tools. |
| `src/persistence` | Local storage (IndexedDB), autosave, `.opendesign` import and export. |
| `src/state` | The editor store (document, selection, undo history) and the command table that menus and shortcuts share. |
| `src/ui` | The React interface: file browser, toolbar, menus, layers, properties, canvas host. |
| `e2e` | Browser acceptance tests. |

[PROJECT_ARCHITECTURE.md](PROJECT_ARCHITECTURE.md) explains the design and [DOCUMENT_SCHEMA.md](DOCUMENT_SCHEMA.md) defines the file format.

## Licence

OPEN DESIGN is released under the [MIT License](LICENSE). The Inter font that ships with it is under the SIL Open Font License 1.1; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
