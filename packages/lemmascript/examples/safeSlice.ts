// examples/safeSlice.ts

//@ backend dafny
//@ safe-slice



function sliceNegativeStart(): number[] {
  //@ ensures \result === [2]
  return [1, 2].slice(-1, 2);
}

function sliceNegativeEnd(): number[] {
  //@ ensures \result === [1]
  return [1, 2].slice(0, -1);
}

function sliceNegativeBounds(): number[] {
  //@ ensures \result === [2, 3]
  return [1, 2, 3, 4].slice(-3, -1);
}
