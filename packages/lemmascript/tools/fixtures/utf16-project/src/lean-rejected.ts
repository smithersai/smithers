// No `//@ backend` directive, so `--backend=lean` reaches the profile check
// instead of skipping the file: javascript-utf16 is Dafny-only.
export function greeting(): string {
  //@ verify
  //@ ensures \result.length === 2
  return "hi";
}
