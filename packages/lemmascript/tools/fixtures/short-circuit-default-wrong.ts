// Wrong twin: without the guard preconditions, the default or arm that JavaScript selects still checks its call.

//@ verify
//@ requires n > 0
//@ ensures \result == n + 1
function positive(n: number): number { let value = n; value = value + 1; return value; }

//@ verify
//@ requires n > 0
//@ ensures \result.length == 2
function label(n: number): string { let text = "a"; text = text + "b"; return text; }

//@ verify
//@ ensures n !== 0 ==> \result == n
//@ ensures n === 0 ==> \result == d + 1
export function numberDefault(n: number, d: number): number {
  return n || positive(d);
}

//@ verify
//@ ensures text.length > 0 ==> \result == text
//@ ensures text.length === 0 ==> \result.length == 2
export function stringDefault(text: string, d: number): string {
  return text || label(d);
}

//@ verify
//@ ensures o !== undefined && o !== 0 ==> \result == o
//@ ensures o === undefined || o === 0 ==> \result == d + 1
export function optionalDefault(o: number | undefined, d: number): number {
  return o || positive(d);
}

//@ verify
//@ ensures xs !== undefined ==> \result == xs.length
//@ ensures xs === undefined ==> \result == 1
export function optionalArrayDefault(xs: number[] | undefined, d: number): number {
  const chosen = xs || [positive(d)];
  return chosen.length;
}

//@ verify
//@ requires k in m
//@ ensures m[k] !== 0 ==> \result == m[k]
//@ ensures m[k] === 0 ==> \result == d + 1
export function storedDefault(m: Record<string, number>, k: string, d: number): number {
  if (k in m) return m[k] || positive(d);
  return 0;
}

//@ verify
//@ requires xs.length > 0
//@ ensures \result == xs.length + 1
function size(xs: number[]): number { let value = xs.length; value = value + 1; return value; }

//@ verify
//@ ensures Array.isArray(value) ==> \result == value.length + 1
//@ ensures !Array.isArray(value) ==> \result == 0
export function arrayArm(value: number[] | number): number {
  return Array.isArray(value) ? size(value) : 0;
}
