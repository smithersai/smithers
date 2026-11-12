// `x === undefined || P(x)` reads x narrowed on the right, as TypeScript narrows it: absent is true, present checks P.

export function longEnough(text: string): boolean {
  return text.length >= 2
}

export function absentOrLong(text: string | undefined): boolean {
  //@ ensures \result === (text === undefined || longEnough(text))
  //@ ensures text !== undefined && text.length < 2 ==> !\result
  return text === undefined || longEnough(text)
}

export function bothBounded(a: string | undefined, b: string | undefined): boolean {
  //@ ensures \result === ((a === undefined || a.length > 0) && (b === undefined || b.length < 9))
  //@ ensures a === undefined && b === undefined ==> \result
  return (a === undefined || a.length > 0) && (b === undefined || b.length < 9)
}

export function eitherAbsentOrLonger(a: string | undefined, b: string | undefined): boolean {
  //@ ensures \result === (a === undefined || b === undefined || a.length > b.length)
  if (a === undefined || b === undefined) return true
  return a.length > b.length
}
