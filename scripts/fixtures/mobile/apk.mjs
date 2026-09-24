// Builders for synthetic APKs in the scripts' tests: ZIP archives, ELF
// libraries, and APK Signing Blocks with the certificates a test chooses.

import zlib from "node:zlib"

/**
 * A ZIP archive with the given entries. `padding` adds bytes to an entry's
 * local extra field only, the way zipalign does, and `alignTo` pads the
 * entry so its data starts on that boundary.
 */
export function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data, method = 8, alignTo = 0 } of files) {
    const nameBytes = Buffer.from(name, "utf8")
    const stored = method === 8 ? zlib.deflateRawSync(data) : data
    let extra = Buffer.alloc(0)
    if (alignTo) {
      const dataStart = offset + 30 + nameBytes.length
      extra = Buffer.alloc((alignTo - (dataStart % alignTo)) % alignTo)
    }
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(extra.length, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    const localRecord = Buffer.concat([local, nameBytes, extra, stored])
    locals.push(localRecord)
    centrals.push(Buffer.concat([central, nameBytes]))
    offset += localRecord.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** A little-endian ELF shared library with one PT_LOAD header per alignment (and one PT_DYNAMIC). */
export function makeElf(alignments, { bits = 64 } = {}) {
  const headerSize = bits === 64 ? 64 : 52
  const entrySize = bits === 64 ? 56 : 32
  const headers = [...alignments.map((align) => ({ type: 1, align })), { type: 2, align: 8 }]
  const elf = Buffer.alloc(headerSize + entrySize * headers.length)
  elf.writeUInt32BE(0x7f454c46, 0)
  elf[4] = bits === 64 ? 2 : 1
  elf[5] = 1
  elf[6] = 1
  if (bits === 64) {
    elf.writeBigUInt64LE(BigInt(headerSize), 0x20)
    elf.writeUInt16LE(entrySize, 0x36)
    elf.writeUInt16LE(headers.length, 0x38)
  } else {
    elf.writeUInt32LE(headerSize, 0x1c)
    elf.writeUInt16LE(entrySize, 0x2a)
    elf.writeUInt16LE(headers.length, 0x2c)
  }
  headers.forEach(({ type, align }, index) => {
    const at = headerSize + index * entrySize
    elf.writeUInt32LE(type, at)
    if (bits === 64) elf.writeBigUInt64LE(BigInt(align), at + 0x30)
    else elf.writeUInt32LE(align, at + 0x1c)
  })
  return elf
}

/** uint32-length-prefixed bytes. */
export const prefixed = (...parts) => {
  const body = Buffer.concat(parts)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(body.length)
  return Buffer.concat([length, body])
}
export const uint32 = (value) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

/** A signature scheme block with one signer presenting `certificates`. */
export function schemeBlock(certificates, { v3 = false } = {}) {
  const digests = prefixed(prefixed(uint32(0x0103), prefixed(Buffer.alloc(32, 1))))
  const certificateList = prefixed(...certificates.map((certificate) => prefixed(certificate)))
  // v3 signed data carries minSdk and maxSdk without a length prefix.
  const signedData = v3
    ? prefixed(digests, certificateList, uint32(24), uint32(0x7fffffff), prefixed())
    : prefixed(digests, certificateList, prefixed())
  const signer = v3
    ? prefixed(signedData, uint32(24), uint32(0x7fffffff), prefixed(), prefixed(Buffer.alloc(8)))
    : prefixed(signedData, prefixed(), prefixed(Buffer.alloc(8)))
  return prefixed(signer)
}

/** Puts an APK Signing Block with the given ID-value pairs in front of the central directory. */
export function withSigningBlock(archive, pairs) {
  const end = archive.length - 22
  const centralDirectory = archive.readUInt32LE(end + 16)
  const pairBytes = pairs.map(([id, value]) => {
    const header = Buffer.alloc(12)
    header.writeBigUInt64LE(BigInt(value.length + 4))
    header.writeUInt32LE(id, 8)
    return Buffer.concat([header, value])
  })
  const size = Buffer.alloc(8)
  size.writeBigUInt64LE(BigInt(pairBytes.reduce((sum, pair) => sum + pair.length, 0) + 8 + 16))
  const block = Buffer.concat([size, ...pairBytes, size, Buffer.from("APK Sig Block 42", "latin1")])
  const result = Buffer.concat([archive.subarray(0, centralDirectory), block, archive.subarray(centralDirectory)])
  result.writeUInt32LE(centralDirectory + block.length, result.length - 22 + 16)
  return result
}

/** An APK whose v2 signature names `certificate` (the bytes of a DER certificate). */
export function signedApk(certificate, entries = [{ name: "AndroidManifest.xml", data: Buffer.from("<manifest/>") }]) {
  return withSigningBlock(makeZip(entries), [[0x7109871a, schemeBlock([certificate])]])
}
