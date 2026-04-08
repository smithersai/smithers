/**
 * Unwraps Zod wrapper types (nullable, optional, default) to get the base type.
 */
export function unwrapZodType(t: any): any {
  if (!t) return t;

  if (t._zod?.def) {
    const typeName = t._zod.def.type;
    if (
      typeName === "nullable" ||
      typeName === "optional" ||
      typeName === "default"
    ) {
      const inner = t._zod.def.innerType;
      return inner ? unwrapZodType(inner) : t;
    }
  }

  return t;
}
