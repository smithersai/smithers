export function classify(value: string | number[]): number {
  //@ ensures Array.isArray(value) ==> \result === 2
  //@ ensures !Array.isArray(value) ==> \result === 1
  return !Array.isArray(value) ? 1 : 2;
}

interface Envelope {
  content: string | number[];
}

export function classifyContent(input: Envelope): number {
  //@ ensures Array.isArray(input.content) ==> \result === 2
  //@ ensures !Array.isArray(input.content) ==> \result === 1
  return !Array.isArray(input.content) ? 1 : 2;
}
