import { smithersSpanAttributeAliases } from "./_smithersSpanAttributeAliases";

type SmithersSpanAttributesInput = Readonly<Record<string, unknown>>;

export function makeSmithersSpanAttributes(
  attributes: SmithersSpanAttributesInput = {},
): Record<string, unknown> {
  const spanAttributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    const nextKey =
      key.startsWith("smithers.") ? key : (smithersSpanAttributeAliases[key] ?? key);
    spanAttributes[nextKey] = value;
  }
  return spanAttributes;
}
