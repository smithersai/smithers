/**
 * A collector stand-in for the VibeLang quickstart test: a `fetch` that
 * records the path of every export request and answers 200 without
 * networking. It lives in TypeScript because the global `Response` is
 * platform code.
 *
 * @throws {never}
 */
export const collector = () => {
  const paths: Array<string> = []
  const fetch: typeof globalThis.fetch = (input) => {
    paths.push(new URL(String(input)).pathname)
    return Promise.resolve(new Response("{}", { status: 200 }))
  }
  return { paths, fetch }
}
