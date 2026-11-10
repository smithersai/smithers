/**
 * TypeDecls — declaration lookup over a module's type declarations
 * (DESIGN_LS_IN_LS.md §5.2).
 *
 * One home for the lookup idioms formerly re-spelled at each use site.
 * Three name semantics exist, and call sites deliberately differ:
 *   - exact:  `declOf` — the name as written;
 *   - dotted: `declOfDotted` — exact, else the last dotted segment
 *     (`Agent.Info` matches `//@ declare-type Info`);
 *   - sliced: `declOfTy`/`tyBaseName` — generic arguments stripped
 *     (`Foo<Bar>` looks up `Foo`).
 * Preserve a site's semantics when changing its lookup; do not "upgrade"
 * an exact site to dotted or sliced in passing.
 */

import type { Ty } from "./typedir.js";
import type { TypeDeclInfo } from "./types.js";

export type TypeDecls = readonly TypeDeclInfo[];

/** `Foo<Bar>` → `Foo`. The single home of the generic-base slice; §5.1
 *  (structured generic args) retires it. */
export function tyBaseName(name: string): string {
  return name.includes("<") ? name.slice(0, name.indexOf("<")) : name;
}

/** Declaration by exact name. */
export function declOf(decls: TypeDecls, name: string): TypeDeclInfo | undefined {
  return decls.find(d => d.name === name);
}

/** Declaration by exact name, restricted to the given kinds. */
export function declOfKind(decls: TypeDecls, name: string,
    ...kinds: TypeDeclInfo["kind"][]): TypeDeclInfo | undefined {
  const d = declOf(decls, name);
  return d && kinds.includes(d.kind) ? d : undefined;
}

/** Declaration by exact name, falling back to the last dotted segment. */
export function declOfDotted(decls: TypeDecls, name: string): TypeDeclInfo | undefined {
  const direct = declOf(decls, name);
  if (direct) return direct;
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx >= 0) return declOf(decls, name.slice(dotIdx + 1));
  return undefined;
}

/** Declaration for a user-typed value: generic-base sliced, exact match.
 *  Undefined for non-user types. */
export function declOfTy(decls: TypeDecls, ty: Ty): TypeDeclInfo | undefined {
  return ty.kind === "user" ? declOf(decls, tyBaseName(ty.name)) : undefined;
}

/** The discriminated-union declaration of a user-typed value, if any. */
export function unionDeclOfTy(decls: TypeDecls, ty: Ty): TypeDeclInfo | undefined {
  const d = declOfTy(decls, ty);
  return d?.kind === "discriminated-union" ? d : undefined;
}

/** The discriminant field name of a user-typed value that is a
 *  discriminated union. */
export function discriminantOf(decls: TypeDecls, ty: Ty): string | undefined {
  return unionDeclOfTy(decls, ty)?.discriminant;
}

/** Reverse lookup: the union declaration owning a variant (discriminated
 *  union) or literal value (string union) of this name. */
export function declWithVariant(decls: TypeDecls, ctorOrValue: string): TypeDeclInfo | undefined {
  return decls.find(d => (d.kind === "discriminated-union" || d.kind === "string-union") &&
    ((d.variants?.some(v => v.name === ctorOrValue)) || (d.values?.includes(ctorOrValue) ?? false)));
}
