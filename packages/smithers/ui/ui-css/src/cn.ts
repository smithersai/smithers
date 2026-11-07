/** Values accepted by the class-name composer (compatible with clsx). */
export type ClassValue = string | number | bigint | boolean | null | undefined | ClassValue[] | Record<string, any>;

function classString(value: ClassValue): string {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  let result = "";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = classString(entry);
      if (nested) result += result ? ` ${nested}` : nested;
    }
  } else if (typeof value === "object") {
    for (const key in value) if (value[key]) result += result ? ` ${key}` : key;
  }
  return result;
}

/** Compose namespaced classes, conditional dictionaries and nested arrays. */
export function cn(...inputs: ClassValue[]): string {
  return inputs.map(classString).filter(Boolean).join(" ");
}
