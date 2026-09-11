export interface StaticChunk {
  readonly fileName: string
  readonly imports: ReadonlyArray<string>
}

/**
 * Splitting a module graph must not introduce initialization cycles between
 * output chunks. A vendor-only cycle can fail before the entry/watchdog runs,
 * even though nobody imports the entry chunk back.
 */
export const assertAcyclicChunks = (chunks: ReadonlyArray<StaticChunk>): void => {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const complete = new Set<string>()
  const active = new Map<string, number>()
  const path: string[] = []
  const visit = (name: string): void => {
    const start = active.get(name)
    if (start !== undefined) {
      throw new Error(
        `Static output chunks form an initialization cycle: ${
          [...path.slice(start), name].join(" -> ")
        }. Preserve dependency evaluation order; do not size-split this graph.`
      )
    }
    if (complete.has(name)) return
    active.set(name, path.length)
    path.push(name)
    for (const dependency of byFile.get(name)?.imports ?? []) visit(dependency)
    path.pop()
    active.delete(name)
    complete.add(name)
  }
  for (const chunk of chunks) visit(chunk.fileName)
}
