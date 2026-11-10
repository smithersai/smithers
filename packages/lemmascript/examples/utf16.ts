//@ backend dafny
//@ option string-semantics javascript-utf16
//@ option dafny-library local

// JavaScript counts UTF-16 code units: this emoji occupies two.
export function emojiLength(): number {
  //@ verify
  //@ ensures \result === 2
  return "😀".length;
}

// Slicing one code unit may produce an unpaired surrogate.
export function emojiFirstCodeUnit(): number {
  //@ verify
  //@ ensures \result === 0xD83D
  return "😀".slice(0, 1).charCodeAt(0);
}

// UTF-16 uses local collection helpers rather than Dafny's standard library.
export function allTextIsNonempty(): boolean {
  //@ verify
  //@ ensures \result === true
  return ["😀", "text"].every(value => value.length > 0);
}
