/*
 * The `/ws` topic lifecycle shared by PtyClient.ts, TargetRunClient.ts and
 * LspClient.ts (docs/LOCAL-APP.md "HTTP and WebSocket API"): one socket per
 * client, opened by the first attachment, carrying one `subscribe` frame per
 * live key. The first listener on a key subscribes its topic and the last one
 * releases it, every live topic is re-subscribed after a reconnect, and the
 * socket only comes back while attachments exist, so a disposed client stays
 * gone. Each client keeps what is its own: the topic name, the frame schema,
 * and whatever it announces on top of the subscription. The close-code
 * policies of CloudTerminalClient.ts and CloudLspClient.ts are a different
 * transport and are deliberately not here.
 */

/** The listeners attached to one key, or undefined when nobody is listening to it. */
export type TopicListeners<Listener> = (key: string) => ReadonlySet<Listener> | undefined

export interface TopicSocketOptions<Listener> {
  /** The `/ws` URL; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: () => string | undefined
  /** Per-launch local capability carried as a WebSocket subprotocol. */
  readonly socketProtocols?: (() => ReadonlyArray<string>) | undefined
  readonly reconnectMs?: number | undefined
  /** The server-side topic name of one key. */
  readonly topicOf: (key: string) => string
  /**
   * One parsed message. Binary frames and text that is not JSON never reach
   * it; deciding what a frame means, and which key it belongs to, is the
   * client's job.
   */
  readonly onMessage: (message: unknown, listeners: TopicListeners<Listener>) => void
  /**
   * Runs just after this socket sends `subscribe` for a key, on the first
   * attachment and again after every reconnect. Anything sent here follows the
   * subscription on the wire, which is what a client announcing an attachment
   * needs.
   */
  readonly onSubscribe?: ((key: string, send: (text: string) => void) => void) | undefined
  /** Runs when a key loses its last listener, after the `unsubscribe` frame. */
  readonly onDetach?: ((key: string) => void) | undefined
  /** Runs when the socket closes under a live client, before the reconnect. */
  readonly onClose?: (() => void) | undefined
}

export interface TopicSocket<Listener> {
  /** Subscribe one key; the returned function detaches that listener. */
  readonly attach: (key: string, listener: Listener) => () => void
  /** Send one frame; false when no open socket took it. */
  readonly send: (text: string) => boolean
  readonly isOpen: () => boolean
  /** Open the socket, unless one is open already or the client is disposed. */
  readonly ensure: () => void
  /** Close the socket, forget every listener and stop reconnecting. */
  readonly dispose: () => void
}

export const createTopicSocket = <Listener>(options: TopicSocketOptions<Listener>): TopicSocket<Listener> => {
  const listeners = new Map<string, Set<Listener>>()
  let socket: WebSocket | undefined
  let disposed = false
  let reconnect: ReturnType<typeof setTimeout> | undefined

  const isOpen = (): boolean => socket !== undefined && socket.readyState === WebSocket.OPEN

  const send = (text: string): boolean => {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
    socket.send(text)
    return true
  }

  const subscribe = (target: WebSocket, key: string): void => {
    target.send(JSON.stringify({ type: "subscribe", topic: options.topicOf(key) }))
    options.onSubscribe?.(key, (text) => target.send(text))
  }

  const scheduleReconnect = (): void => {
    if (disposed || listeners.size === 0 || reconnect !== undefined) return
    reconnect = setTimeout(() => {
      reconnect = undefined
      ensureSocket()
    }, options.reconnectMs ?? 1000)
    ;(reconnect as { unref?: () => void }).unref?.()
  }

  const ensureSocket = (): void => {
    if (disposed || socket !== undefined) return
    const url = options.socketUrl()
    if (url === undefined) return
    const protocols = options.socketProtocols?.() ?? []
    const opened = protocols.length === 0 ? new WebSocket(url) : new WebSocket(url, [...protocols])
    socket = opened
    opened.onopen = () => {
      if (socket !== opened) return
      for (const key of listeners.keys()) subscribe(opened, key)
    }
    opened.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      options.onMessage(parsed, (key) => listeners.get(key))
    }
    opened.onclose = () => {
      if (socket === opened) {
        socket = undefined
        options.onClose?.()
      }
      scheduleReconnect()
    }
    opened.onerror = () => {
      // onclose follows and schedules the reconnect.
    }
  }

  const attach = (key: string, listener: Listener): (() => void) => {
    const set = listeners.get(key) ?? new Set<Listener>()
    const first = set.size === 0
    set.add(listener)
    listeners.set(key, set)
    if (first) {
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) subscribe(socket, key)
      else ensureSocket()
    }
    return () => {
      const current = listeners.get(key)
      if (current === undefined) return
      current.delete(listener)
      if (current.size > 0) return
      listeners.delete(key)
      send(JSON.stringify({ type: "unsubscribe", topic: options.topicOf(key) }))
      options.onDetach?.(key)
    }
  }

  const dispose = (): void => {
    disposed = true
    if (reconnect !== undefined) clearTimeout(reconnect)
    listeners.clear()
    const closing = socket
    socket = undefined
    closing?.close()
  }

  return { attach, send, isOpen, ensure: ensureSocket, dispose }
}
