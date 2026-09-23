import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const targets = new Map([
  ["backend", { directory: path.join("apps", "backend"), name: "@betterc0de/backend" }],
  ["schema", { directory: path.join("packages", "schema"), name: "@betterc0de/schema" }],
])
const sourceExtensions = [".ts", ".tsx", ".js", ".jsx"]

function containedPath(root, relative) {
  const absolute = path.resolve(root, relative)
  const remainder = path.relative(root, absolute)
  if (!remainder || remainder === ".." || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder)) {
    throw new Error(`Build path is outside its workspace: ${relative}`)
  }
  return absolute
}

/** Check every existing component without following a symlink or junction. */
function inspectPath(root, relative) {
  const absolute = containedPath(root, relative)
  let current = root
  let result
  for (const part of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, part)
    try {
      result = fs.lstatSync(current)
    } catch (error) {
      if (error?.code === "ENOENT") return null
      throw error
    }
    if (result.isSymbolicLink()) {
      throw new Error(`Refusing symlinked build path: ${current}`)
    }
    if (current !== absolute && !result.isDirectory()) {
      throw new Error(`Build ancestor is not a directory: ${current}`)
    }
  }
  return result
}

function requireDirectory(root, relative) {
  if (!inspectPath(root, relative)?.isDirectory()) {
    throw new Error(`Build directory is missing or invalid: ${relative}`)
  }
}

function hasSource(root, sourceRelative, relativeOutput) {
  // A former foo.ts emits foo.js, which shadows a newer foo/index.js in Node.
  // An index source therefore must not keep the stale sibling foo.js alive.
  const stem = relativeOutput.replace(/\.js(?:\.map)?$/, "")
  for (const extension of sourceExtensions) {
    const relative = path.join(sourceRelative, `${stem}${extension}`)
    const source = inspectPath(root, relative)
    if (!source) continue
    if (!source.isFile()) throw new Error(`Source is not a regular file: ${relative}`)
    return true
  }
  return false
}

function validateRoot(absoluteRoot) {
  const rootStat = fs.lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.relative(absoluteRoot, fs.realpathSync(absoluteRoot)) !== "") {
    throw new Error(`Build workspace must be a real directory: ${absoluteRoot}`)
  }
}

/**
 * Symlinks above the workspace are part of the machine's layout, not of the
 * build: macOS reaches /tmp and /var through /private, and home directories
 * are often links. Resolve the ancestors once, keep the workspace directory
 * itself unresolved so a symlinked root is still refused, and let
 * validateRoot's re-checks catch an ancestor that changes afterwards.
 */
function canonicalRoot(root) {
  const resolved = path.resolve(root)
  const parent = path.dirname(resolved)
  if (parent === resolved) return resolved
  return path.join(fs.realpathSync(parent), path.basename(resolved))
}

/** Remove only stale generated JS/maps; never recursively delete directories. */
export function pruneBuildOutput(target, root = repositoryRoot) {
  const configuration = targets.get(target)
  if (!configuration) throw new Error("Build target must be backend or schema")
  const absoluteRoot = canonicalRoot(root)
  validateRoot(absoluteRoot)
  const sourceRelative = path.join(configuration.directory, "src")
  const outputRelative = path.join(configuration.directory, "dist")
  const manifestRelative = path.join(configuration.directory, "package.json")
  if (!inspectPath(absoluteRoot, manifestRelative)?.isFile()) {
    throw new Error("Workspace package.json is missing or invalid")
  }
  const manifest = JSON.parse(fs.readFileSync(containedPath(absoluteRoot, manifestRelative), "utf8"))
  if (manifest?.name !== configuration.name) {
    throw new Error(`Refusing to prune a directory without the ${target} workspace manifest`)
  }
  requireDirectory(absoluteRoot, sourceRelative)
  const output = inspectPath(absoluteRoot, outputRelative)
  if (!output) return [] // Fresh clones have no generated output yet.
  if (!output.isDirectory()) throw new Error("Build dist is not a directory")

  const candidates = []
  function visit(relativeDirectory) {
    requireDirectory(absoluteRoot, path.join(outputRelative, relativeDirectory))
    const directory = containedPath(absoluteRoot, path.join(outputRelative, relativeDirectory))
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = path.join(relativeDirectory, name)
      const entry = inspectPath(absoluteRoot, path.join(outputRelative, relative))
      if (!entry) throw new Error(`Build output changed while inspecting: ${relative}`)
      if (entry.isDirectory()) visit(relative)
      else if (entry.isFile() && /\.js(?:\.map)?$/.test(name) && !hasSource(absoluteRoot, sourceRelative, relative)) {
        candidates.push(relative)
      }
    }
  }
  visit("") // Validate the complete output tree before any deletion.

  const removed = []
  for (const relative of candidates) {
    // Recheck roots, ancestors and source immediately before each individual unlink.
    validateRoot(absoluteRoot)
    requireDirectory(absoluteRoot, sourceRelative)
    requireDirectory(absoluteRoot, outputRelative)
    const outputPath = containedPath(absoluteRoot, path.join(outputRelative, relative))
    const entry = inspectPath(absoluteRoot, path.join(outputRelative, relative))
    if (!entry) continue
    if (!entry.isFile()) throw new Error(`Build output is no longer a regular file: ${relative}`)
    if (hasSource(absoluteRoot, sourceRelative, relative)) continue
    fs.unlinkSync(outputPath)
    removed.push(relative.replaceAll(path.sep, "/"))
  }
  return removed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/prune-build-output.mjs backend|schema")
  const target = process.argv[2]
  const removed = pruneBuildOutput(target)
  console.log(`[prune-build-output] ${target}: removed ${removed.length} stale JavaScript/source-map files`)
}
