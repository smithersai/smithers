export {}
type Intent = { readonly type: "A"; readonly n: number } | { readonly type: "B" }
const LIMIT = 8000
//@ verify
//@ ensures \result >= 0
function step(intent: Intent): number {
  switch (intent.type) {
    case "A": return intent.n > LIMIT ? LIMIT : 0
    case "B": return 0
  }
}
