/**
 * Unwraps Zod wrapper types (nullable, optional, default) to get the base type.
 */
export function unwrapZodType(t: any): any {
  if (!t) return t;

  // Zod v4 style
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
    return t;
  }

  // Zod v3 fallback
  const typeName = t._def?.typeName;
  if (typeName === "ZodNullable" || typeName === "ZodOptional") {
    const inner = t._def?.innerType;
    return inner ? unwrapZodType(inner) : t;
  }
  if (typeName === "ZodDefault") {
    const inner = t._def?.innerType;
    return inner ? unwrapZodType(inner) : t;
  }

  return t;
}
