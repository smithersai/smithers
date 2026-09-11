import type { TargetRunFrame } from "@smthrs/rpc/LocalApp"
import { TargetRunMessageSchema } from "@smthrs/rpc/LocalApp"
import { createTopicSocket } from "./TopicSocket"

/*
 * The target-run transport (docs/LOCAL-APP.md "HTTP and WebSocket API"):
 * one WebSocket to `/ws` shared by every run card. Attaching to a run
 * subscribes its `target-run:<runId>` topic and announces the attachment
 * (`target-run.attach`), which is what starts the child on the server, so no
 * frame is published before anyone listens. Frames sent before the socket is
 * open wait for it; every live topic is re-subscribed after a reconnect.
 * TopicSocket.ts owns that lifecycle; what is target-run's own is the topic
 * name, the frame schema and the announcement.
 */

export interface TargetRunClient {
  /** Subscribe to one run's frames; the returned function detaches. */
  readonly attach: (runId: string, onFrame: (frame: TargetRunFrame) => void) => () => void
  readonly dispose: () => void
}

export interface TargetRunClientOptions {
  /** The `/ws` URL; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: () => string | undefined
  /** Per-launch local capability carried as a WebSocket subprotocol. */
  readonly socketProtocols?: () => ReadonlyArray<string>
  readonly reconnectMs?: number
}

export const createTargetRunClient = (options: TargetRunClientOptions): TargetRunClient => {
  const topics = createTopicSocket<(frame: TargetRunFrame) => void>({
    socketUrl: options.socketUrl,
    socketProtocols: options.socketProtocols,
    reconnectMs: options.reconnectMs,
    topicOf: (runId) => `target-run:${runId}`,
    /* The announcement starts the child, so it must follow the subscription, never precede it. */
    onSubscribe: (runId, send) => send(JSON.stringify({ type: "target-run.attach", runId })),
    onMessage: (message, listeners) => {
      const parsed = TargetRunMessageSchema.safeParse(message)
      if (!parsed.success) return
      const set = listeners(parsed.data.runId)
      if (set === undefined) return
      for (const listener of set) listener(parsed.data.frame)
    }
  })

  return { attach: topics.attach, dispose: topics.dispose }
}
