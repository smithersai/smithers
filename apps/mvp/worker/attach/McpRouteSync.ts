export const invalidTool = (message: string): never => {
  throw new TypeError(message)
}

export const webResponse = (body: string | null, init: ResponseInit): Response =>
  new Response(body, init)
