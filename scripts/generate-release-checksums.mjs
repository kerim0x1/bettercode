import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const releaseDir = path.resolve(
  process.env.RELEASE_DIR ?? path.join(import.meta.dirname, "..", "release"),
)
const checksumFile = (process.env.CHECKSUM_FILE ?? "SHA256SUMS.txt").replace(
  /[^A-Za-z0-9._-]/g,
  "-",
)
const supportedExtensions = [".apk", ".appimage", ".deb", ".dmg", ".exe", ".rpm", ".zip", ".gz"]
const files = fs.existsSync(releaseDir)
  ? fs
      .readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => supportedExtensions.some((extension) => name.toLowerCase().endsWith(extension)))
      .sort()
  : []

if (files.length === 0) {
  throw new Error(`No release artifacts found in ${releaseDir}`)
}

const lines = files.map((name) => {
  const bytes = fs.readFileSync(path.join(releaseDir, name))
  return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`
})
fs.writeFileSync(path.join(releaseDir, checksumFile), `${lines.join("\n")}\n`)
process.stdout.write(`Wrote checksums for ${files.length} release artifact(s).\n`)
