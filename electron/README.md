# Evora desktop app (Electron)

The desktop app is the web app in a native window for Windows, macOS and Linux. It works offline, with no server. Everything in it is free and unlimited, as in the web app.

## Commands

| Command | What it does |
|---|---|
| `npm run desktop` | Runs the app in development: Vite's dev server on port 5173 (which passes `/api` and `/ws` to `EVORA_SERVER` or `localhost:8787`, as `npm run dev` does), with the main process and preload compiled first. Closing the app stops Vite. |
| `npm run desktop:build` | Builds the web app (`dist/`, after the type check) and compiles `electron/` into `dist-electron/`. |
| `npm run dist:desktop` | Builds, then makes the installers for the current system into `release/` with electron-builder. Extra flags go to electron-builder (`npm run dist:desktop -- --publish never`). |
| `npm run e2e:desktop` | The desktop tests (`e2e/desktop.spec.ts`, Playwright's Electron support). Run `npm run desktop:build` first. |
| `npm run desktop:icons` | Draws the icons in `build/` from `public/favicon.svg` with Electron itself (no image tools). |

Only `electron`, `electron-builder` and `electron-updater` are added for this; electron-builder downloads its own tools (NSIS, and on macOS and Linux what it needs there) when it builds.

## How it is put together

- `main.ts`: windows, one instance, the menus, files given by the system, closing, crashes, the bridge's IPC handlers.
- `appProtocol.ts` and `staticFiles.ts`: the app is served from `app://evora/`, a privileged scheme (secure and standard, so IndexedDB, the clipboard and fonts work as on https), read from `dist/` in the package. Its pages get a strict Content-Security-Policy (`desktopCsp` in `src/persistence/desktopContract.ts`). `app://evora/api/…` is passed on to the collaboration server chosen in the settings (with none it answers 503 "No collaboration server is set"), so the app's API client works unchanged; the WebSocket goes to that server directly (`src/collab/endpoint.ts`).
- `preload.cts`: exposes `window.evoraDesktop` (the contract is `src/persistence/desktopContract.ts`) and nothing else. Pages run with context isolation and the sandbox, without Node.
- `files.ts`: Open, Save, links between library files and disk files, recent files, recovery copies. A page can only read or write a path the person gave the app (a dialog, the command line, a double-click, a drop, Open Recent) or one it saved before.
- `menu.ts` and `menuSpec.ts`: the native menus. Command items run the app's own commands (`src/state/commands.ts`) in the window; a unit test checks their labels and shortcuts against the commands. On Windows and Linux the shortcuts are shown but left to the window (`registerAccelerator: false`), so the editor and text fields keep their keys; on macOS, where a menu always takes its shortcut, only shortcuts with ⌘ are given.
- `hostServer.ts`: "Host a team server from this computer" (File ▸ Collaboration…).
- `updates.ts`: automatic updates.
- `settings.ts`: the app's settings and where the window was.

In the web app, `src/ui/desktop/DesktopMount.tsx` (mounted beside the app in `src/main.tsx`) and `src/ui/desktop/useDesktopEditor.ts` (one line in the editor) do the window's part. Both do nothing in a browser.

## Files on disk

The editor always works on a file of the app's library (IndexedDB, as in the browser), which it saves by itself after every change. A `.evora` file opened from disk becomes such a file, **linked** to its path: Save (Ctrl+S) writes it back there, and the window's title shows `•` while the disk file is behind. Opening the same path again, unchanged on disk, opens the same library file; changed on disk, it is read afresh. `.opendesign`, `.fig` and `.svg` files become new library files that are not linked: Save asks where to write a `.evora` (an SVG becomes a new file with the drawing placed in it as layers). "Save a copy as .fig…" writes a Figma file and lists what it cannot hold.

Files reach the app from File ▸ Open…, File ▸ Open recent (and the system's recent documents: the Jump List on Windows, the Dock on macOS), the command line (`Evora.exe design.evora`), a double-click (the installers register `.evora`, `.opendesign` and `.fig`), a drop on the window or on the Dock icon, and a second launch (the running app opens the file).

Closing a window whose linked file has unsaved changes asks: Save, Don't save (the changes stay in the library file, and the link is let go so the disk file opens afresh next time), or Cancel. While such a file has unsaved changes, a copy is kept in the app's data folder (`recovery/`); it is removed when the file is saved or the window closes normally. If the app ended without that, the next start asks "Evora closed unexpectedly. Recover …?".

If a window's page crashes or stops responding, the app offers to reload it; the open file comes back from what was saved automatically. The window's place and size are remembered.

## Collaboration

File ▸ Collaboration… (on macOS, Evora ▸ Collaboration…) sets the collaboration server's address. With none (the default) everything stays on this computer. Changing it reloads the windows, after saving what they have.

"Host a team server from this computer" starts Evora's own server (`server/main.ts`, unchanged) as a child process of the app's executable in Node mode (`ELECTRON_RUN_AS_NODE=1`; Electron's Node 24 runs the `.ts` files by stripping their types and has `node:sqlite`). It listens on every network address of the computer on the chosen port (8787 by default), keeps its data in the app's data folder (`team-server/`), serves the app to browsers too, and shows the addresses others use. It stops when the app quits. The system's firewall may ask whether Evora may accept connections.

Not working in the desktop app: "Continue with Google" (the server only sends people back to a web address).

## Installers

`build` in `package.json` (electron-builder):

- **Windows:** an NSIS installer (`Evora-Setup-<version>.exe`) that asks whether to install for the current user (the default, no administrator rights) or everyone and lets you choose the folder, and a portable `Evora-<version>-portable.exe`. x64.
- **macOS:** `.dmg` and `.zip`, for Intel (x64) and Apple silicon (arm64).
- **Linux:** AppImage and `.deb`, x64.

The macOS and Linux installers cannot be built on Windows; the release workflow builds them on GitHub's runners.

## Signing

Nothing is signed yet: there are no certificates. Signing is wired to turn on from the environment, with no change to the code:

- Windows and macOS: `CSC_LINK` (the certificate, a path, URL or base64 of a .p12/.pfx) and `CSC_KEY_PASSWORD`, which electron-builder reads itself.
- macOS notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` (with a signing certificate). The hardened runtime and `build/entitlements.mac.plist` are already set.
- Without them, on macOS set `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder does not pick some identity from the keychain.

What unsigned builds mean: Windows SmartScreen warns about an unknown publisher ("More info ▸ Run anyway"). macOS Gatekeeper refuses to open an unsigned, un-notarized app downloaded from the internet until it is allowed in System Settings ▸ Privacy & Security (or with right-click ▸ Open).

## Automatic updates

electron-updater, from the project's GitHub Releases (`publish` in `package.json`: owner ShishirShastry, repo evora). An installed app checks when it starts (the setting `checkUpdates`, on by default) and from Help ▸ Check for updates… (Evora ▸ Check for updates… on macOS), downloads in the background, and offers "Restart to update"; an update not installed then is installed when the app quits. In development, and in the portable Windows build, the menu item says that updates work in the installed app.

Without signing:

- **Windows (NSIS):** works. electron-updater checks a signature only when the installed app was signed; unsigned to unsigned installs. SmartScreen may warn when the installer runs.
- **macOS:** does **not** work. Squirrel.Mac, which installs the update, requires the app to be signed (and the update signed by the same identity). An unsigned app finds and downloads the update, then fails to install it; the app says so and offers the releases page.
- **Linux:** the AppImage updates itself (no signing involved). A `.deb` is updated through the system's package tool (`pkexec` asks for the password).

None of this has been tried end to end: it needs a published release with a newer version.
