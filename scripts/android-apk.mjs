// Reads what an Android APK contains and how it is signed, for
// scripts/mobile-android.mjs and the release assembly. No dependencies: a
// ZIP central-directory reader, an ELF program-header reader, and parsers
// for the text the Android SDK tools print (apksigner, aapt2, keytool).

import zlib from "node:zlib"

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50

/** Android devices with 16 KB memory pages load only libraries aligned to them. */
export const PAGE_SIZE_16K = 16 * 1024
/** The ABIs that can run on 16 KB page devices (all 64-bit). */
export const SIXTY_FOUR_BIT_ABIS = ["arm64-v8a", "x86_64"]

/**
 * The entries of a ZIP archive (an APK is one), from its central directory.
 * `dataOffset` is where the entry's stored bytes start in the archive.
 */
export function readZipEntries(archive) {
  const end = findEndOfCentralDirectory(archive)
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported.")
  }
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error("The ZIP central directory is damaged.")
    }
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const externalAttributes = archive.readUInt32LE(offset + 38)
    const localOffset = archive.readUInt32LE(offset + 42)
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength)
    if (archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new Error(`The ZIP entry ${name} has no local header.`)
    }
    // The local header's extra field may differ from the central one (the
    // alignment padding zipalign adds lives there).
    const dataOffset =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28)
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      dataOffset,
      unixMode: externalAttributes >>> 16,
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findEndOfCentralDirectory(archive) {
  const minimum = 22
  const earliest = Math.max(0, archive.length - minimum - 0xffff)
  for (let offset = archive.length - minimum; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  throw new Error("Not a ZIP archive: no end of central directory.")
}

/** The uncompressed bytes of one entry. */
export function readZipEntry(archive, entry) {
  const stored = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  if (entry.method === 0) return stored
  if (entry.method === 8) return zlib.inflateRawSync(stored)
  throw new Error(`${entry.name} uses ZIP compression method ${entry.method}, which is not supported.`)
}

/** The `p_align` of every loadable segment of an ELF shared library. */
export function elfLoadSegmentAlignments(library) {
  if (library.length < 52 || library.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error("Not an ELF file.")
  }
  const is64 = library[4] === 2
  const little = library[5] === 1
  const u16 = (at) => (little ? library.readUInt16LE(at) : library.readUInt16BE(at))
  const u32 = (at) => (little ? library.readUInt32LE(at) : library.readUInt32BE(at))
  const u64 = (at) => Number(little ? library.readBigUInt64LE(at) : library.readBigUInt64BE(at))
  const headerOffset = is64 ? u64(0x20) : u32(0x1c)
  const headerSize = is64 ? u16(0x36) : u16(0x2a)
  const headerCount = is64 ? u16(0x38) : u16(0x2c)
  const PT_LOAD = 1
  const alignments = []
  for (let index = 0; index < headerCount; index += 1) {
    const header = headerOffset + index * headerSize
    if (u32(header) !== PT_LOAD) continue
    alignments.push(is64 ? u64(header + 0x30) : u32(header + 0x1c))
  }
  return alignments
}

/** ABIs the APK carries native libraries for, e.g. ["arm64-v8a", "x86_64"]. */
export function nativeAbis(entries) {
  const abis = new Set()
  for (const { name } of entries) {
    const match = /^lib\/([^/]+)\/[^/]+\.so$/.exec(name)
    if (match) abis.add(match[1])
  }
  return [...abis].sort()
}

/**
 * Native libraries that a device with 16 KB pages could not load: a
 * loadable segment aligned to less than a page, or, for a library stored
 * uncompressed (loaded straight from the APK), a file offset off a page.
 */
export function misalignedLibraries(archive, entries = readZipEntries(archive), pageSize = PAGE_SIZE_16K) {
  const problems = []
  for (const entry of entries) {
    const match = /^lib\/([^/]+)\/[^/]+\.so$/.exec(entry.name)
    if (!match || !SIXTY_FOUR_BIT_ABIS.includes(match[1])) continue
    const smallest = Math.min(...elfLoadSegmentAlignments(readZipEntry(archive, entry)))
    if (smallest < pageSize) {
      problems.push(`${entry.name}: segments aligned to ${smallest} bytes`)
    }
    if (entry.method === 0 && entry.dataOffset % pageSize !== 0) {
      problems.push(`${entry.name}: stored at offset ${entry.dataOffset}, not on a ${pageSize}-byte page`)
    }
  }
  return problems
}

/** Colon-separated or plain hex, any case → lowercase hex. */
export function normalizeFingerprint(value) {
  return String(value ?? "")
    .replaceAll(":", "")
    .replace(/\s+/g, "")
    .toLowerCase()
}

/** `apksigner verify --verbose --print-certs` */
export function parseApksignerOutput(text) {
  const lines = String(text).split(/\r?\n/)
  const schemes = {}
  const signers = []
  let signerCount = null
  for (const line of lines) {
    const scheme = /^Verified using (v[\d.]+) scheme \([^)]*\): (true|false)$/.exec(line.trim())
    if (scheme) schemes[scheme[1]] = scheme[2] === "true"
    const count = /^Number of signers: (\d+)$/.exec(line.trim())
    if (count) signerCount = Number(count[1])
    const signer = /^Signer #(\d+) certificate (DN|SHA-256 digest): (.+)$/.exec(line.trim())
    if (signer) {
      const index = Number(signer[1]) - 1
      signers[index] ??= {}
      if (signer[2] === "DN") signers[index].dn = signer[3]
      else signers[index].sha256 = normalizeFingerprint(signer[3])
    }
  }
  return {
    verified: lines.some((line) => line.trim() === "Verifies"),
    schemes,
    signerCount,
    signers: signers.filter(Boolean),
  }
}

/** `aapt2 dump badging` */
export function parseBadging(text) {
  const result = {
    packageName: null,
    versionCode: null,
    versionName: null,
    minSdk: null,
    targetSdk: null,
    nativeCode: [],
    permissions: [],
    debuggable: false,
  }
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("package:")) {
      const attributes = Object.fromEntries([...line.matchAll(/(\w+)='([^']*)'/g)].map((match) => [match[1], match[2]]))
      result.packageName = attributes.name ?? null
      result.versionCode = attributes.versionCode ? Number(attributes.versionCode) : null
      result.versionName = attributes.versionName ?? null
    } else if (line.startsWith("minSdkVersion:") || line.startsWith("sdkVersion:")) {
      // aapt2 prints minSdkVersion; the older aapt printed sdkVersion.
      result.minSdk = Number(/'(\d+)'/.exec(line)?.[1])
    } else if (line.startsWith("targetSdkVersion:")) {
      result.targetSdk = Number(/'(\d+)'/.exec(line)?.[1])
    } else if (line.startsWith("native-code:")) {
      result.nativeCode = [...line.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()
    } else if (line.startsWith("uses-permission:")) {
      const name = /name='([^']+)'/.exec(line)?.[1]
      if (name) result.permissions.push(name)
    } else if (line.trim() === "application-debuggable") {
      result.debuggable = true
    }
  }
  result.permissions.sort()
  return result
}

/** The SHA-256 certificate fingerprint `keytool -list -v` prints. */
export function parseKeytoolFingerprint(text) {
  const match = /^\s*SHA256:\s*([0-9A-Fa-f:]+)\s*$/m.exec(String(text))
  return match ? normalizeFingerprint(match[1]) : null
}
