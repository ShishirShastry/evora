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
- `auth.ts`: "Continue with Google" through the system's browser, back at `evora://auth` (below).
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

### Continue with Google

Google cannot send anyone back to `app://evora/`, so the desktop app signs in through the system's browser (`auth.ts`, the usual pattern for desktop apps):

1. "Continue with Google" makes, in the main process, a random nonce and a random PKCE verifier, remembers them with the time, the window and the collaboration server's origin, and opens the server's `/api/auth/google/start?origin=<server>&mode=…&desktop=1&nonce=…&code_challenge=<base64url(SHA-256(verifier))>&code_challenge_method=S256` in the system's browser (`shell.openExternal`, awaited, only at the configured server's own http(s) address; when the browser cannot be opened, the dialog says so and nothing is left waiting). With no server chosen, the dialog says to choose one first.
2. The server runs its usual Google flow in that browser and ends on a page that says "Click Open Evora to finish", whose "Open Evora" link (and a best-effort meta refresh) goes to `evora://auth?ticket=…&nonce=…` (or `error=…`). The system hands that address to the app: `open-url` on macOS, a second launch on Windows and Linux (the one-instance lock passes its command line to the running app).
3. The app accepts it only with the nonce of a sign-in it made, within 10 minutes, for the collaboration server the sign-in started at, and once. Up to five sign-ins may wait at once (several windows, or a second click), each finishing in the window that started it; a window whose sign-in is let go to make room (or that took too long by then) is told so. When no sign-in is waiting, or none has the address's nonce (any page or program can launch `evora://auth`), the address is ignored and the app only comes to the front, and the sign-ins under way keep waiting. A sign-in that took too long, or whose server was changed since, is refused with a message, one at a time.
4. The main process then redeems the one-time ticket (single use, two minutes) at the server's `/api/auth/google/redeem` with the verifier, and sends the session to the window that started the sign-in (`onGoogleReturn` on `window.evoraDesktop`). The window keeps it where it is, without changing route, so an open document stays open, and the sign-in dialog says who is signed in (`src/ui/collab/google.tsx`).

The server redeems a ticket made for the desktop only with the verifier whose challenge it was given at the start, and burns it when it is brought without it; it refuses (and burns) a web ticket brought with a verifier, so a web ticket slipped into `evora://auth` cannot sign the app in to someone else's account. So another program that registered `evora://` too and caught the address of a sign-in the app started cannot use the ticket. What PKCE cannot stop (RFC 8252, 8.6): such a program can start a desktop sign-in of its own, with its own verifier, in the person's browser and catch that one's address if the person goes through Google and clicks Open Evora; the server's last page therefore says to go on only after clicking Continue with Google in Evora just then. The verifier never leaves the main process: it is in no address, no IPC message and no log. Only the one-time ticket is ever in an address.

The `evora` scheme is registered by the app itself when it starts (`app.setAsDefaultProtocolClient`; in development with Electron's path and the app's folder, and never in a test run) and by the installers (`build.protocols` in `package.json`).

What the server needs: Google set up as in [Continue with Google](../docs/self-hosting.md#continue-with-google), with the server's own address as the app origin. The server accepts only its public URL (`EVORA_PUBLIC_URL`) or a `localhost` address as the origin, and Google accepts only https or localhost redirect addresses, so a team server reached by a network address such as `http://192.168.1.20:8787` needs a public https URL for this to work. Not verified yet: the whole round trip with the real Google and a real browser on each system (the parts are unit-tested; the meta refresh to `evora://` may make the browser ask "Open Evora?" first, or be ignored, which is why the page asks the person to click its link).

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
- Without them, on macOS set `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder does not pick some identity from the keychain, and add `-c.mac.identity=- -c.mac.hardenedRuntime=false` so the app is signed ad hoc (the release workflow does both). Without an ad-hoc signature macOS calls a downloaded copy "damaged".

What unsigned builds mean: Windows SmartScreen warns about an unknown publisher ("More info ▸ Run anyway"). macOS Gatekeeper refuses to open an ad-hoc signed, un-notarized app downloaded from the internet until it is allowed once in System Settings ▸ Privacy & Security ▸ Open Anyway.

## Automatic updates

electron-updater, from the project's GitHub Releases (`publish` in `package.json`: owner ShishirShastry, repo evora). An installed app checks when it starts (the setting `checkUpdates`, on by default) and from Help ▸ Check for updates… (Evora ▸ Check for updates… on macOS), downloads in the background, and offers "Restart to update"; an update not installed then is installed when the app quits. In development, and in the portable Windows build, the menu item says that updates work in the installed app.

Without signing:

- **Windows (NSIS):** works. electron-updater checks a signature only when the installed app was signed; unsigned to unsigned installs. SmartScreen may warn when the installer runs.
- **macOS:** does **not** install. Squirrel.Mac, which installs the update, requires the app to be signed with a Developer ID (and the update signed by the same identity). So a Mac copy checks its signature with `codesign` first (once per run); without a Developer ID (the ad-hoc builds) it looks for a new version without downloading it and offers that version's disk image for this Mac in a dialog, once per version when the app starts (remembered in `update-notice.json` in the data folder) and every time from the menu (`electron/updateNotice.ts`). A Mac copy signed with a Developer ID updates itself like the others.
- **Linux:** the AppImage updates itself (no signing involved). A `.deb` is updated through the system's package tool (`pkexec` asks for the password).

None of this has been tried end to end: it needs a published release with a newer version.
