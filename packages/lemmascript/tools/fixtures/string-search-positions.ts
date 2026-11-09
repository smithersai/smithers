//@ backend dafny

export function includesAt(text: string, needle: string, position: number): boolean {
  return text.includes(needle, position);
}

export function startsAt(text: string, needle: string, position: number): boolean {
  return text.startsWith(needle, position);
}

export function endsAt(text: string, needle: string, position: number): boolean {
  return text.endsWith(needle, position);
}

export function indexAt(text: string, needle: string, position: number): number {
  return text.indexOf(needle, position);
}

export function positionedPredicates(): boolean {
  //@ ensures \result === true
  return !"a".includes("a", 1)
    && "ab".includes("b", 1)
    && "ab".startsWith("b", 1)
    && !"ab".startsWith("a", 1)
    && "ab".endsWith("a", 1)
    && !"ab".endsWith("b", 1);
}

export function clampedPredicates(): boolean {
  //@ ensures \result === true
  return "abc".includes("a", -10)
    && !"abc".includes("a", 10)
    && "abc".includes("", 10)
    && "abc".startsWith("a", -10)
    && !"abc".startsWith("a", 10)
    && "abc".startsWith("", 10)
    && "abc".endsWith("", -10)
    && !"abc".endsWith("a", -10)
    && "abc".endsWith("c", 10);
}

export function emptyNeedlePastEnd(): number {
  //@ ensures \result === 3
  return "abc".indexOf("", 10);
}
