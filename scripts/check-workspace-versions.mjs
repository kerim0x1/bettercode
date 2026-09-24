import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const manifests = [
  "package.json",
  "apps/backend/package.json",
  // The phone app ships with every desktop release under the same version
  // (apps/mobile/app.config.ts derives the store versions from it).
  "apps/mobile/package.json",
  "apps/shell/package.json",
  "apps/ui/package.json",
  "packages/schema/package.json",
  "packages/util/package.json",
]

const versions = manifests.map((relativePath) => {
  const value = JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"))
  return { path: relativePath, version: value.version }
})
const expected = versions[0]?.version
const mismatches = versions.filter(({ version }) => version !== expected)

const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
for (const { path: manifestPath, version } of versions) {
  const lockKey = manifestPath === "package.json" ? "" : path.dirname(manifestPath).replaceAll("\\", "/")
  const lockVersion = lock.packages?.[lockKey]?.version
  if (lockVersion !== version) {
    mismatches.push({
      path: `package-lock.json#packages[${JSON.stringify(lockKey)}]`,
      version: lockVersion,
    })
  }
}

if (typeof expected !== "string" || !expected.trim()) {
  throw new Error("Root package version is missing.")
}
if (mismatches.length > 0) {
  const details = mismatches
    .map(({ path: mismatchPath, version }) => `${mismatchPath}: ${String(version)}`)
    .join("\n")
  throw new Error(`Workspace versions must all equal ${expected}:\n${details}`)
}

process.stdout.write(`Workspace version contract passed (${expected}).\n`)
