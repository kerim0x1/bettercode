#!/usr/bin/env node

// [PACKAGING] Shared electron-builder arguments.
//
// Every package is built by `scripts/release-check.mjs` (`npm run package`,
// `build:*`, `package:dir*` and CI all go through it), so local and released
// builds come out of one pipeline. This module only holds the signing
// metadata argument that pipeline passes to electron-builder. The schema
// workspace package reaches app.asar through the `files` mapping in
// package.json, so no vendor/restore step around electron-builder is needed.

/**
 * `--config.extraMetadata.betterc0deCodeSigned=<bool>` — electron-builder
 * merges `extraMetadata` into the packaged `package.json`, so the renderer
 * process can read the build's signing posture at runtime.
 *
 * `main.cjs` used to gate the Windows update check on
 * `process.env.WIN_CSC_LINK`, which is a BUILD-time variable — at runtime in
 * an installed app it is never set, so every shipped Windows build silently
 * never checked for updates, including security fixes. A runtime check needs
 * a value that survives packaging.
 *
 * Windows and macOS count as signed only when a signing certificate was
 * supplied. Notarization credentials (APPLE_TEAM_ID) alone do not sign the
 * app, and Squirrel.Mac refuses to update an unsigned one. Linux packages
 * carry no code signature; their update mode is chosen from the package type
 * at runtime (shared/update-policy.cjs), so the flag is honestly false there.
 */
function buildSigningMetadataArgs(env = process.env, platform = process.platform) {
  const hasWindowsCert = Boolean(env.WIN_CSC_LINK || env.CSC_LINK);
  const hasMacCert = Boolean(env.CSC_LINK || env.CSC_NAME);
  const signed =
    platform === "win32"
      ? hasWindowsCert
      : platform === "darwin"
        ? hasMacCert
        : false;
  return [`--config.extraMetadata.betterc0deCodeSigned=${signed ? "true" : "false"}`];
}

module.exports = {
  buildSigningMetadataArgs,
};
