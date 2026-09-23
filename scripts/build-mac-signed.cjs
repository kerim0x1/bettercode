#!/usr/bin/env node

// `npm run build:mac:signed`: a local signed and notarized macOS build.
//
// Reads signing credentials from the git-ignored `.env.signing` file in the
// repository root and passes them to `npm run build:mac`. The file uses
// shell-style assignments, one per line:
//
//   CSC_LINK=/absolute/path/to/DeveloperID.p12
//   CSC_KEY_PASSWORD=...
//   APPLE_ID=you@example.com
//   APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
//   APPLE_TEAM_ID=ABCDE12345
//
// This replaces a `bash -c 'source .env.signing'` one-liner so the command
// no longer depends on bash, and reports missing values by name.

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const REQUIRED = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

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

function main() {
  if (process.platform !== "darwin") {
    console.error("[build-mac-signed] only runs on macOS: codesign and notarytool are macOS tools.");
    return 1;
  }
  const envFile = path.join(repoRoot, ".env.signing");
  if (!fs.existsSync(envFile)) {
    console.error(
      `[build-mac-signed] ${envFile} is missing. Create it with ${REQUIRED.join(", ")} ` +
        "(see docs/development/code-signing.md). It is git-ignored; never commit it.",
    );
    return 1;
  }
  const values = parseEnvFile(fs.readFileSync(envFile, "utf8"));
  const missing = REQUIRED.filter((name) => !values[name]);
  if (missing.length > 0) {
    console.error(`[build-mac-signed] .env.signing does not set: ${missing.join(", ")}`);
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
  try {
    process.exitCode = main();
  } catch (error) {
    console.error("[build-mac-signed]", error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = { parseEnvFile };
