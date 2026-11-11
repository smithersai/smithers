// An unannotated local object is read by field: it is a record, not a tuple.
//@ verify
//@ ensures \result == value
export function local(value: number): number {
  const step = { value, stamp: value + 1 };
  return step.value;
}

//@ verify
//@ ensures \result == value + 1
export function stamp(value: number): number {
  const step = { value, stamp: value + 1 };
  const next = { step, label: "n" };
  return next.step.stamp;
}
