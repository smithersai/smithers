//@ verify
//@ ensures \result == (value ?? 123)
export function zeroSafe(value: number): number { return value ? value : 123 }
