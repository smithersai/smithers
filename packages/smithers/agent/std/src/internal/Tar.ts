/**
 * The regular files of a tar stream.
 *
 * `RemoteSearch` brings a machine's files back with its own `tar`, because
 * every image ships one and it frames each file with its name and size. GNU
 * and BusyBox `tar` write GNU long names, `bsdtar` writes POSIX extended
 * headers, and `xargs` may start `tar` more than once, so the stream can hold
 * several archives one after another. This reads all of them.
 *
 * @since 1.0.0-rc.8
 */

const decoder = new TextDecoder()

/** Bytes up to the first NUL, as text. */
const text = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0)
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
}

/** An octal header field, or `undefined` when it holds anything else. */
const octal = (bytes: Uint8Array): number | undefined => {
  const digits = text(bytes).trim()
  return /^[0-7]+$/.test(digits) ? Number.parseInt(digits, 8) : undefined
}

/** The header's checksum, computed with the checksum field read as spaces. */
const checksum = (header: Uint8Array): number => {
  let sum = 0
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!
  return sum
}

/** The `path` record of a POSIX extended header: `<length> <key>=<value>\n` records. */
const paxPath = (data: Uint8Array): string | undefined => {
  let offset = 0
  let path: string | undefined
  while (offset < data.length) {
    const space = data.indexOf(32, offset)
    const length = space === -1 ? Number.NaN : Number(decoder.decode(data.subarray(offset, space)))
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.length) return path
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1))
    if (record.startsWith("path=")) path = record.slice("path=".length)
    offset += length
  }
  return path
}

/**
 * Every regular file the stream holds, by member name, or `undefined` when
 * the stream is not whole tar archives: a header whose checksum does not
 * hold, a member cut short, or a last archive with no end. A `tar` that
 * stopped between two members wrote no end, so its missing files are not
 * mistaken for files it could not read.
 *
 * @private
 * @since 1.0.0-rc.8
 * @throws {never}
 */
export const files = (stream: Uint8Array): ReadonlyMap<string, Uint8Array> | undefined => {
  const found = new Map<string, Uint8Array>()
  let longName: string | undefined
  let extended: string | undefined
  let ended = true
  for (let offset = 0; offset + 512 <= stream.length;) {
    const header = stream.subarray(offset, offset + 512)
    offset += 512
    // Zero blocks end one archive; `xargs` may have started another.
    ended = header.every((byte) => byte === 0)
    if (ended) continue
    const size = octal(header.subarray(124, 136))
    if (size === undefined || octal(header.subarray(148, 156)) !== checksum(header)) return undefined
    if (offset + size > stream.length) return undefined
    const data = stream.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    const type = String.fromCharCode(header[156]!)
    if (type === "L") {
      longName = text(data)
      continue
    }
    if (type === "x") {
      extended = paxPath(data) ?? extended
      continue
    }
    // A long link name and a global header describe no member of their own.
    if (type === "K" || type === "g") continue
    if (type === "0" || type === "\0" || type === "7") {
      const prefix = decoder.decode(header.subarray(257, 263)) === "ustar\0" ? text(header.subarray(345, 500)) : ""
      const short = text(header.subarray(0, 100))
      found.set(extended ?? longName ?? (prefix === "" ? short : `${prefix}/${short}`), data.slice())
    }
    longName = undefined
    extended = undefined
  }
  return ended ? found : undefined
}
