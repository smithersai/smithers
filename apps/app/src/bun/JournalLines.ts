import { open } from "node:fs/promises"

/*
 * Streams a journal one line at a time. A run journal keeps every log byte,
 * so a repository's history can be far larger than what a reader wants to
 * retain; reading whole files with readFile + split materializes the entire
 * journal twice before a caller can drop anything. Here at most one chunk
 * and one partial line are resident at a time, and the caller decides what
 * to keep. The trailing `\r` of a CRLF line is stripped; a final line without
 * a newline is yielded as-is (a crash can leave one, the parser skips it).
 */
const DEFAULT_JOURNAL_CHUNK_BYTES = 256 * 1024

export async function* readJournalLines(path: string, chunkBytes: number = DEFAULT_JOURNAL_CHUNK_BYTES): AsyncGenerator<string> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes)
    const decoder = new TextDecoder()
    let rest = ""
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const parts = (rest + decoder.decode(buffer.subarray(0, bytesRead), { stream: true })).split("\n")
      rest = parts.pop() ?? ""
      for (const part of parts) yield part.endsWith("\r") ? part.slice(0, -1) : part
    }
    rest += decoder.decode()
    if (rest !== "") yield rest.endsWith("\r") ? rest.slice(0, -1) : rest
  } finally {
    await handle.close()
  }
}
