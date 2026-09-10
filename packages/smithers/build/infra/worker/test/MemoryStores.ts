import type { ActionCache, ActionCachePublication, ContentStore, DeleteFence } from "../protocol.ts"

export class MemoryActionCache implements ActionCache {
  readonly entries = new Map<string, ActionCachePublication>()

  async get(key: string): Promise<string | null> {
    return this.entries.get(key)?.body ?? null
  }

  async put(
    key: string,
    publication: ActionCachePublication
  ): Promise<"conflict" | "identical" | "inserted"> {
    const stored = this.entries.get(key)
    if (stored === undefined) {
      this.entries.set(key, publication)
      return "inserted"
    }
    return stored.resultJson === publication.resultJson ? "identical" : "conflict"
  }

  async delete(key: string, fence: DeleteFence | null): Promise<boolean> {
    const stored = this.entries.get(key)
    if (stored === undefined) return false
    if (
      fence !== null &&
      (stored.recordedRunId !== fence.runId || stored.recordedEventSeq !== fence.eventSeq)
    ) {
      return false
    }
    return this.entries.delete(key)
  }
}

export class MemoryContentStore implements ContentStore {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>()
  presentCalls = 0

  async get(digest: string): Promise<{ readonly body: BodyInit } | null> {
    const bytes = this.objects.get(digest)
    return bytes === undefined ? null : { body: bytes }
  }

  async has(digest: string): Promise<boolean> {
    return this.objects.has(digest)
  }

  async put(
    digest: string,
    bytes: Uint8Array<ArrayBuffer>
  ): Promise<"inserted" | "present"> {
    if (this.objects.has(digest)) return "present"
    this.objects.set(digest, new Uint8Array(bytes))
    return "inserted"
  }

  async presentDigests(digests: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    this.presentCalls += 1
    return new Set(digests.filter((digest) => this.objects.has(digest)))
  }
}
