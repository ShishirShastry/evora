/**
 * For a Mac copy of Evora that cannot install updates itself (see
 * electron/updates.ts). macOS installs an update only into an app signed with
 * a Developer ID, and only when the update is signed by the same identity
 * (Squirrel.Mac checks both). Until Evora's Mac builds are signed that way they
 * are signed ad hoc (release.yml), so such a copy looks for a new version but
 * does not download it: it tells the person and offers the new version's disk
 * image instead.
 *
 * No Electron in here, so the unit tests can load it.
 */

/**
 * Whether the output of `codesign --display --verbose=2` names a Developer ID
 * as the app's signing authority. An ad-hoc signature names no authority, and
 * an "Apple Development" certificate is not one macOS installs updates from.
 */
export function signedWithDeveloperId(codesignOutput: string): boolean {
  return /^Authority=Developer ID Application: /m.test(codesignOutput);
}

/** A file of a release, as the update feed (latest-mac.yml) lists it. */
export interface ReleaseFile {
  url: string;
}

/**
 * Where to download `version` for this Mac: its disk image for `arch` ("arm64"
 * or "x64") from the files the update feed lists (a .zip and a .dmg for each
 * architecture), or the release's page when no disk image fits.
 */
export function macDownloadUrl(releasesUrl: string, version: string, files: readonly ReleaseFile[], arch: string): string {
  const page = `${releasesUrl}/tag/v${version}`;
  const images = files.filter((file) => typeof file.url === 'string' && /\.dmg$/i.test(file.url));
  const chosen = images.find((file) => file.url.endsWith(`-${arch}.dmg`)) ?? (images.length === 1 ? images[0] : undefined);
  if (!chosen) return page;
  try {
    const url = new URL(chosen.url, `${releasesUrl}/download/v${version}/`);
    return url.protocol === 'https:' ? url.toString() : page;
  } catch {
    return page;
  }
}
