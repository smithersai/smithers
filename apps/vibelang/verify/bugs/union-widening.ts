// LemmaScript reads TypeScript; widening a string union must preserve its value.
type Narrow = "docs" | "splash"
type Wide = Narrow | "palette"
//@ verify
//@ ensures value == "docs" ==> \result == "docs"
//@ ensures value == "splash" ==> \result == "splash"
export function widen(value: Narrow): Wide {
  return value
}
