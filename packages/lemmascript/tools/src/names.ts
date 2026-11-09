/**
 * Fresh names for toolchain-minted identifiers.
 *
 * Several passes synthesize names — loop counters (`_x_idx`), lift temps
 * (`_t0`), someMatch binders (`_task_val`), quantifier binders. Any such name
 * can collide with a user-written identifier and either capture it (silently
 * changing semantics — the `.delete()` binder bug) or shadow it (a
 * loud duplicate-variable error in the backend).
 *
 * The rule, chosen for zero churn to existing output: a minted name is used
 * verbatim unless the user wrote the same identifier somewhere in the module,
 * in which case a prime (`'`) is appended. TypeScript identifiers cannot
 * contain a prime, while Dafny and Lean both accept them, so one prime always
 * suffices; and priming preserves distinctness among minted names, so the
 * existing counter/suffix schemes keep working unchanged.
 *
 * The module-wide check deliberately over-approximates scope — a colliding
 * name anywhere in the file primes the mint. False positives only affect
 * internal names nobody reads. Names with a user-facing meaning stay exact by
 * different, local means: comprehension binders check the expressions they
 * actually wrap (`usesName` in dafny-emit), and result binders check the
 * signature/body in hand (`methodHeader`). Spec text (`//@` comments) is NOT
 * scanned: specs may legitimately reference minted names (e.g. `_x_idx` loop
 * counters in invariants), so a spec mention is a reference, not a collision
 * — when a source collision does force a prime, spec references are expected
 * to follow it.
 */

let _userNames = new Set<string>();

/** Seeded once per module by extract with every Identifier token in the
 *  source — params, locals, fields, callees alike. */
export function setUserNames(names: Set<string>): void {
  _userNames = names;
}

export function isUserName(name: string): boolean {
  return _userNames.has(name);
}

/** The raw user identifiers, for a backend that needs to allocate its own
 *  emitted names against them (e.g. Dafny escaping — see dafny-emit). */
export function userNames(): readonly string[] {
  return [..._userNames];
}

/** A toolchain-internal name: `base` verbatim, primed on collision against
 *  user-written names anywhere in the module. The common form — deterministic
 *  per module. */
export function freshName(base: string): string {
  return freshNameWhere(base, isUserName);
}

/** The priming rule, against a caller-chosen collision predicate — for
 *  callers that know the exact scope (e.g. a comprehension binder checking
 *  only the expressions it wraps). The one place the rule lives. */
export function freshNameWhere(base: string, taken: (name: string) => boolean): string {
  let name = base;
  while (taken(name)) name += "'";
  return name;
}
