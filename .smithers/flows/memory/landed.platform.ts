// The platform code of landed.vibe: decoding a child process's byte stream to text, which may reject malformed UTF-8.
import { Stream } from "effect"

/** The whole of `stream` as text, decoded as it arrives. */
export const collect = <E>(stream: Stream.Stream<Uint8Array, E>) => {
  const text = new TextDecoder()
  return Stream.runFold(stream, () => "", (all, chunk: Uint8Array) => all + text.decode(chunk, { stream: true }))
}
