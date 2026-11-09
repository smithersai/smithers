/** A platform Request, for a workerd host that calls its own entrypoint. */
export function webRequest(url: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array | undefined }): Request {
  return new Request(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body as BodyInit }) })
}
