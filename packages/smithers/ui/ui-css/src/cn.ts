/** Values accepted by the class-name composer (compatible with clsx). */
export type ClassValue = string | number | bigint | boolean | null | undefined | ClassValue[] | Record<string, any>;

function classString(value: ClassValue): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  let result = "";
  if (Array.isArray(value)) {
    // clsx reads indexed entries, captures the length, and ignores iterators.
    for (let index = 0, length = value.length; index < length; index++) {
      if (value[index]) {
        const nested = classString(value[index]);
        if (nested) result += result ? ` ${nested}` : nested;
      }
    }
  } else if (typeof value === "object") {
    for (const key in value) if (value[key]) result += result ? ` ${key}` : key;
  }
  return result;
}

/** Compose namespaced classes, conditional dictionaries and nested arrays. */
export function cn(...inputs: ClassValue[]): string {
  const groups: string[] = [];
  for (const input of inputs) {
    if (input) {
      const group = classString(input);
      if (group) groups.push(group);
    }
  }
  return groups.join(" ");
}
