# Releasing Evora

How a version of Evora is built, published and found by the copies people have
installed. Everything here runs on GitHub Actions from the files in
`.github/workflows/`; nothing is built or uploaded from a personal machine.

> Status: these workflows were written and checked locally (the YAML parses,
> every npm script and path they name exists or is agreed), but **they have not
> run on GitHub yet**. The first tagged release is also their first real test.

## Versions

- The version in `package.json` (`"version"`) is the app's version. The
  desktop app, the update files and the self-hosting bundle all take it from
  there.
- A release is the git tag `vX.Y.Z` for that same version. The release
  workflow stops if the tag and `package.json` disagree.
- [Semantic Versioning](https://semver.org/): while the version starts with
  `0.`, a minor step (0.1 -> 0.2) may change things people rely on; a patch
  step (0.1.0 -> 0.1.1) only fixes. A change to the document schema that
  older versions cannot open is at least a minor step.
- [CHANGELOG.md](CHANGELOG.md) collects changes under `## [Unreleased]` as
  they are made.

## Cutting a release, step by step

1. **Make sure `main` is green.** The CI workflow (Actions -> CI) must have
   passed on the commit you are releasing.
2. **Set the version.** Change `"version"` in `package.json` (and run
   `npm install --package-lock-only` so `package-lock.json` has it too).
3. **Write the release notes.** In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD` and add a new, empty `## [Unreleased]` above it.
   The text under `## [X.Y.Z]`, up to the next `## ` heading, becomes the
   release's description; the workflow stops if that section is missing.
4. **Commit and tag** (from your own terminal):

   ```sh
   git commit -am "Release X.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

5. **Watch Actions -> Release.** It runs four jobs:
   - *prepare*: checks the tag against `package.json`, takes the notes from
     the changelog and opens a **draft** release for the tag.
   - *desktop* (Windows, macOS, Linux): `npm run dist:desktop -- --publish always`
     builds the installers with electron-builder and uploads them, with the
     update files, into the draft. On macOS one job builds both Apple silicon
     (arm64) and Intel (x64), so one `latest-mac.yml` lists both.
   - *self-host*: builds the web app, packs it with the server into
     `evora-server-X.Y.Z.tar.gz` (with a `.sha256`), checks that it starts and
     answers `/api/health`, attaches it to the draft, and, if `deploy/Dockerfile`
     exists, pushes the image `ghcr.io/<owner>/<repo>:X.Y.Z` and `:latest`.
6. **Check the draft** (Releases -> the draft for vX.Y.Z). It should hold:
   - Windows: `Evora Setup X.Y.Z.exe` (or the name the desktop config gives),
     its `.blockmap`, and `latest.yml`;
   - macOS: a `.dmg` and a `.zip` for each of arm64 and x64, their
     `.blockmap`s, and `latest-mac.yml`;
   - Linux: the `.AppImage` (and any `.deb`), and `latest-linux.yml`;
   - `evora-server-X.Y.Z.tar.gz` and its `.sha256`.

   Download at least one installer and try it.
7. **Publish the draft** (Edit -> Publish release). Only now can people and
   installed copies see it. To withdraw a bad release, delete it (or mark it
   as a pre-release) and release a higher version; never re-use a tag.

If a job fails, fix the cause on `main`, delete the draft release and the tag
(`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), and tag again.
Re-running a failed job on the same tag also works: electron-builder replaces
files that are already in the draft.

To try the builds **without releasing**, run Actions -> Release -> "Run
workflow" on a branch. Nothing is published then; the installers and the
bundle are kept as workflow artifacts for 14 days.

## How automatic updates find a release

The desktop app uses `electron-updater` with the GitHub provider. When it
checks for updates it asks GitHub for the repository's **latest published
release** (drafts and pre-releases are not offered) and reads the update file
for its platform from it:

| Platform | File it reads | What it downloads |
|---|---|---|
| Windows | `latest.yml` | the NSIS installer, in pieces using the `.blockmap` where it can |
| macOS | `latest-mac.yml` | the `.zip` for the Mac's own architecture |
| Linux | `latest-linux.yml` | the `.AppImage` |

Each file names the version, the file and its SHA-512. If the version is
higher than the running app's, the update is downloaded and installed as the
desktop app's code decides (on quitting, or when the person accepts).
Publishing the draft is what makes an update reach people; deleting a release
stops offering it.

Where the app looks is set by the `publish` section of the electron-builder
configuration (the GitHub owner and repository); electron-builder writes it into
the app as `app-update.yml` when it builds.

What does **not** update itself: the `.deb` package (update it by installing
the new one), the self-hosted server (download the new bundle or pull the new
image), and, while builds are unsigned, macOS (see below).

## Unsigned builds, and what that means for people

There are no code-signing certificates yet, so every installer is **unsigned**.

- **Windows.** SmartScreen shows "Windows protected your PC" when the
  installer is first run; people have to choose "More info" and then
  "Run anyway". Some antivirus programs are more suspicious of unsigned
  installers. Automatic updates still work.
- **macOS.** Gatekeeper does not open an app that is not signed and notarized
  by Apple. Downloaded from a browser, Evora will be reported as "damaged" or
  "cannot be checked for malicious software" and will not open. People can
  still run it by removing the quarantine flag in Terminal
  (`xattr -dr com.apple.quarantine /Applications/Evora.app`) or, on some
  versions of macOS, with System Settings -> Privacy & Security ->
  "Open Anyway"; neither should be asked of most people. **Automatic updates
  do not work on macOS without signing** (macOS refuses to swap in an update
  that is not signed by the same developer), so Mac users have to download each
  new version by hand until the app is signed.
- **Linux.** Linux packages are not signed by this pipeline either; AppImages
  run once they are made executable, and their updates work.

## Turning code signing on later

Nothing in the workflows has to change: the *desktop* job turns signing on by
itself when the secrets below exist, and leaves it off when they do not. Add
them under the repository's Settings -> Secrets and variables -> Actions ->
"New repository secret".

### Windows

1. Get a code-signing certificate (an OV or EV certificate from a certificate
   authority, exported as a `.pfx`/`.p12` with its private key). Note: EV
   certificates and many newer OV ones are only issued on hardware tokens or
   cloud signing services, which cannot be put in a secret; those need
   electron-builder's `win.signtoolOptions` / Azure Trusted Signing settings
   instead, a change to the desktop configuration.
2. Encode the file: `base64 -w0 certificate.p12` (macOS: `base64 -i certificate.p12`).
3. Add the secrets `CSC_LINK` (the base64 text) and `CSC_KEY_PASSWORD` (its
   password).

### macOS (signing and notarization)

1. In an Apple Developer account, create a **Developer ID Application**
   certificate and export it with its private key from Keychain Access as a
   `.p12`.
2. Add `CSC_LINK` (the `.p12` as base64) and `CSC_KEY_PASSWORD`. When the Windows
   and Mac certificates differ, the Windows one can go in `WIN_CSC_LINK` /
   `WIN_CSC_KEY_PASSWORD` instead, which electron-builder prefers on Windows;
   the workflow then needs those two names added to its signing step.
3. For notarization add `APPLE_ID` (the account's email), `APPLE_APP_SPECIFIC_PASSWORD`
   (made at appleid.apple.com -> Sign-In and Security -> App-Specific Passwords)
   and `APPLE_TEAM_ID` (the 10-character team ID from the developer account).
   Notarization runs only when all three and `CSC_LINK` are present.
4. The desktop configuration needs the hardened runtime and entitlements that
   Electron needs (`mac.hardenedRuntime`, `mac.entitlements`), which is part of
   the desktop app's own configuration.

The next tagged release is then signed (and notarized); the log of the
*desktop* job says "Code signing: ON" and "Notarization: ON".

## Settings the repository needs

- **Settings -> Actions -> General -> Workflow permissions:** "Read and write
  permissions". The workflows ask only for what each job needs (`contents:
  write` to create the release and upload files, `packages: write` for the
  container image), but GitHub caps every job at this setting.
- **Container image (optional).** The first push creates the package
  `ghcr.io/<owner>/<repo>` as private; make it public under the package's
  settings if anyone should pull it without signing in. Set the repository
  variable `PUBLISH_CONTAINER_IMAGE` to `false` to stop pushing images.
- **Branch protection (recommended):** require the CI checks on `main`.
- **Private vulnerability reporting (recommended):** Settings -> Code security,
  so the issue template's security link works.

## Files

| File | What it does |
|---|---|
| `.github/workflows/ci.yml` | Checks on every push and pull request to `main` |
| `.github/workflows/release.yml` | The release, on a `vX.Y.Z` tag or by hand |
| `.github/dependabot.yml` | Weekly pull requests for npm packages and actions |
| `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md` | Forms for issues and pull requests |
| `CHANGELOG.md` | What changed in each version |
