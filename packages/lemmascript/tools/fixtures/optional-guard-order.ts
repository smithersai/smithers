export interface Leaf { value?: number }
export interface Box { inner?: Leaf }

export function guardedReturn(box?: Box): number {
  //@ ensures box === undefined ==> \result === -1
  //@ ensures box !== undefined && box.inner === undefined ==> \result === -1
  //@ ensures box !== undefined && box.inner !== undefined && box.inner.value === undefined ==> \result === -1
  //@ ensures box !== undefined && box.inner !== undefined && box.inner.value !== undefined ==> \result === box.inner.value
  if (box !== undefined && box.inner !== undefined && box.inner.value !== undefined) {
    return box.inner.value;
  }
  return -1;
}

export function guardedConditional(box?: Box): number {
  //@ ensures box === undefined ==> \result === -1
  //@ ensures box !== undefined && box.inner === undefined ==> \result === -1
  //@ ensures box !== undefined && box.inner !== undefined && box.inner.value === undefined ==> \result === -1
  //@ ensures box !== undefined && box.inner !== undefined && box.inner.value !== undefined ==> \result === box.inner.value
  return box !== undefined && box.inner !== undefined && box.inner.value !== undefined ? box.inner.value : -1;
}
