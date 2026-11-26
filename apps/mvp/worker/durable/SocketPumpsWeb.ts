export const upgradeResponse = (socket: WebSocket): Response =>
  new Response(null, { status: 101, webSocket: socket })

export const randomTicket = (): `${string}-${string}-${string}-${string}-${string}` =>
  crypto.randomUUID()
