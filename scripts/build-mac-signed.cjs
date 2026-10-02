#!/usr/bin/env node

// `npm run build:mac:signed`: a local signed and notarized macOS build.
//
// Reads signing credentials from the git-ignored `.env.signing` file in the
// repository root and passes them to `npm run build:mac`. electron-builder
// signs with the Developer ID certificate and notarizes and staples the app
// itself. The file uses shell-style assignments, one per line:
//
//   CSC_LINK=/absolute/path/to/DeveloperID.p12
//   CSC_KEY_PASSWORD=...
//   APPLE_TEAM_ID=ABCDE12345
//   # App Store Connect API key (recommended) ...
//   APPLE_API_KEY=/absolute/path/to/AuthKey_ABC123DEFG.p8
//   APPLE_API_KEY_ID=ABC123DEFG
//   APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
//   # ... or an Apple ID with an app-specific password instead:
//   # APPLE_ID=you@example.com
//   # APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
//
// The build runs with BETTERC0DE_MACOS_SIGNING=true, so incomplete
// credentials stop it instead of producing an unsigned app. Missing values
// are reported by name; secret values are never printed.

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

function parseEnvFile(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Cannot parse this line of .env.signing: ${rawLine}`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("[build-mac-signed] only runs on macOS: codesign and notarytool are macOS tools.");
    return 1;
  }
  const envFile = path.join(repoRoot, ".env.signing");
  if (!fs.existsSync(envFile)) {
    console.error(
      `[build-mac-signed] ${envFile} is missing. Create it with the certificate and notarization ` +
        "credentials (see docs/development/code-signing.md). It is git-ignored; never commit it.",
    );
    return 1;
  }
  const values = { ...parseEnvFile(fs.readFileSync(envFile, "utf8")), BETTERC0DE_MACOS_SIGNING: "true" };
  const { assessMacSigning } = await import("./macos-signing.mjs");
  const signing = assessMacSigning(values);
  if (signing.problems.length > 0) {
    for (const problem of signing.problems) console.error(`[build-mac-signed] ${problem}`);
    return 1;
  }

  const npmCli = process.env.npm_execpath;
  const [command, args] =
    npmCli && /npm-cli\.js$/.test(npmCli)
      ? [process.execPath, [npmCli, "run", "build:mac"]]
      : ["npm", ["run", "build:mac"]];
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...values },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("[build-mac-signed]", error && error.message ? error.message : error);
      process.exitCode = 1;
    },
  );
}

module.exports = { parseEnvFile };
