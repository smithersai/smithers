/// LemmaScript reads TypeScript only; ReadonlySet lowering reproduction.
// The first source position whose reply flow has not already been dispatched.
//@ verify
//@ ensures 0 <= \result && \result <= posts.length
//@ ensures \result < posts.length ==> !dispatched.has(posts[\result])
//@ ensures forall(i, 0 <= i && i < \result ==> dispatched.has(posts[i]))
export function firstUndispatched(posts: ReadonlyArray<string>, dispatched: ReadonlySet<string>): number {
  let i = 0
  while (i < posts.length) {
    //@ invariant 0 <= i && i <= posts.length
    //@ invariant forall(j, 0 <= j && j < i ==> dispatched.has(posts[j]))
    //@ decreases posts.length - i
    if (!dispatched.has(posts[i]!)) return i
    i++
  }
  return posts.length
}
