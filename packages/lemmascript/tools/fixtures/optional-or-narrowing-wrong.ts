// The narrowed disjunction is not vacuous: an absent value makes it true, so a body that answers false there fails.

export function absentOrLong(text: string | undefined): boolean {
  //@ ensures \result === (text === undefined || text.length >= 2)
  return text !== undefined && text.length >= 2
}
