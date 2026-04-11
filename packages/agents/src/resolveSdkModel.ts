export function resolveSdkModel<MODEL>(
  value: string | MODEL,
  create: (modelId: string) => MODEL,
): MODEL {
  return typeof value === "string" ? create(value) : value;
}
