export function combineNonEmpty(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.map((part) => (part ?? "").trim()).filter(Boolean);
  return filtered.length ? filtered.join("\n\n") : undefined;
}
