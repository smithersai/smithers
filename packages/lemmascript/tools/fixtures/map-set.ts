// Map and Set in contracts and loops (vl-proveall3). Each key's last index, as `new Map(entries)` keeps it, and a
// map lookup used as a sequence index under its own `k in m` guard.
export interface Item {
  readonly key: string
}

//@ verify
//@ ensures forall(k: string, k in \result ==> 0 <= \result[k] && \result[k] < items.length && items[\result[k]].key == k)
//@ ensures forall(i, 0 <= i && i < items.length ==> items[i].key in \result)
export function lastIndexByKey(items: ReadonlyArray<Item>): Map<string, number> {
  const byKey = new Map<string, number>()
  let i = 0
  while (i < items.length) {
    //@ invariant 0 <= i && i <= items.length
    //@ invariant forall(k: string, k in byKey ==> 0 <= byKey[k] && byKey[k] < i && items[byKey[k]].key == k)
    //@ invariant forall(j, 0 <= j && j < i ==> items[j].key in byKey)
    //@ decreases items.length - i
    byKey.set(items[i]!.key, i)
    i += 1
  }
  return byKey
}

/** Every key reachable from `start` through `children`: the walk ends because `seen` grows inside the map's keys. */
//@ verify
//@ ensures forall(x: string, x in \result ==> x in children)
export function reach(children: Map<string, ReadonlyArray<string>>, start: ReadonlyArray<string>): Set<string> {
  const seen = new Set<string>()
  let stack: ReadonlyArray<string> = start
  while (stack.length > 0) {
    //@ invariant forall(x: string, x in seen ==> x in children)
    //@ decreases children.keys() - seen
    while (stack.length > 0 && (!children.has(stack[stack.length - 1]!) || seen.has(stack[stack.length - 1]!))) {
      //@ invariant forall(x: string, x in seen ==> x in children)
      //@ decreases stack.length
      stack = stack.slice(0, stack.length - 1)
    }
    if (stack.length === 0) break
    const top = stack[stack.length - 1]!
    stack = stack.slice(0, stack.length - 1)
    seen.add(top)
    stack = [...stack, ...(children.get(top) ?? [])]
  }
  return seen
}

export interface Walk {
  readonly step: number
}
export interface Walked {
  readonly walk?: Walk
}

/** A present check beside a coalescing of the same value: the coalescing keeps its own match (narrow.ts matchesOn). */
//@ verify
//@ ensures \result.walk != undefined && (\result.walk ?? { step: 1 }) == { step: step }
export function walked(step: number): Walked {
  return { walk: { step } }
}
