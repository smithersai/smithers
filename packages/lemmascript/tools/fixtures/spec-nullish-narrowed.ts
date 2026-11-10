export interface Item { readonly value: number }
export interface Box { readonly item?: Item }

//@ verify
//@ ensures \result.value == 0
export function emptyItem(): Item { return { value: 0 } }

//@ verify
//@ ensures \result == (box.item ?? emptyItem()).value
//@ ensures box.item != undefined ==> \result == (box.item ?? emptyItem()).value
export function guardedValue(box: Box): number {
  if (box.item === undefined) return 0
  return box.item.value
}

//@ verify
//@ ensures \result == (item ?? emptyItem()).value
export function presentValue(item: Item): number { return item.value }

//@ verify
//@ ensures \result == (value ?? 123)
export function zeroSafe(value: number): number { return value }

//@ verify
//@ ensures \result == (value ?? true)
export function falseSafe(value: boolean): boolean { return value }

//@ verify
//@ ensures \result == (value ?? "fallback")
export function emptySafe(value: string): string { return value }

//@ verify
//@ ensures \result == (0 <= index && index < values.length ? values[index] : 123)
export function indexSafe(values: ReadonlyArray<number>, index: number): number { return values[index] ?? 123 }
