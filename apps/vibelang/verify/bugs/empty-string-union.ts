// LemmaScript reads only TypeScript; this minimal backend reproduction retains the empty string alternative.
type Route = "read" | ""
//@ verify
//@ ensures path == "/" ==> \result == "read"
//@ ensures path != "/" ==> \result == ""
export function route(path: string): Route {
  return path === "/" ? "read" : ""
}
