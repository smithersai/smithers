//@ backend dafny

export function emojiLength(): number {
  //@ verify
  //@ ensures \result === 2
  return "😀".length;
}

export function emojiHighSurrogate(): number {
  //@ verify
  //@ ensures \result === 0xD83D
  return "😀".charCodeAt(0);
}

export function emojiLowSurrogate(): number {
  //@ verify
  //@ ensures \result === 0xDE00
  return "😀".charCodeAt(1);
}

export function unpairedSurrogateLength(): number {
  //@ verify
  //@ ensures \result === 1
  return "\uD83D".length;
}

export function slicedHighSurrogate(): number {
  //@ verify
  //@ ensures \result === 0xD83D
  return "😀".slice(0, 1).charCodeAt(0);
}

export function constructedSurrogate(): number {
  //@ verify
  //@ ensures \result === 0xD83D
  return String.fromCharCode(0xD83D).charCodeAt(0);
}
