// The platform side of src/flows/credentials.vibe: the web `Response` a refused credential answers with.

/**
 * The JSON response `{ code }` with `status`, which the server answered when it refused a run a credential.
 *
 * @throws {never} A status the server already answered with and a JSON body always make a valid response.
 */
export const refusalResponse = (code: string, status: number): Response =>
  new Response(JSON.stringify({ code }), { status, headers: { "content-type": "application/json" } })
