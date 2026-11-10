//@ backend dafny

//@ extern
declare function rollDie(): number;

export function twoDrawsAgree(): boolean {
  //@ verify
  //@ ensures \result === true
  const a = rollDie();
  const b = rollDie();
  return a === b;
}
