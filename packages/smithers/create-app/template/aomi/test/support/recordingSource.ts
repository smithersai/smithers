/**
 * A byte source that serves `chunks` one pull at a time and records the reason
 * each consumer cancel carried.
 *
 * With `fail`, the source errors with it after the last chunk instead of
 * closing, which is the ending a provider that dies mid-turn produces.
 */
export const recordingSource = (
  chunks: ReadonlyArray<string>,
  options: { readonly fail?: Error } = {}
): { readonly stream: ReadableStream<Uint8Array>; readonly cancels: Array<unknown> } => {
  const encoder = new TextEncoder()
  const cancels: Array<unknown> = []
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!))
        index += 1
        return
      }
      if (options.fail !== undefined) {
        controller.error(options.fail)
        return
      }
      controller.close()
    },
    cancel(reason) {
      cancels.push(reason)
    }
  })
  return { stream, cancels }
}
