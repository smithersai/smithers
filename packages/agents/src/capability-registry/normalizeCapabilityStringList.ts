export function normalizeCapabilityStringList(
  values: readonly string[] | null | undefined,
): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}
