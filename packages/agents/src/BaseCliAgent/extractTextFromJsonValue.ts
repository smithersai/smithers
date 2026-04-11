export function extractTextFromJsonValue(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    const parts = value.content
      .map((part: any) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .join("");
    if (parts.trim()) return parts;
  }
  if (value.response) return extractTextFromJsonValue(value.response);
  if (value.message) return extractTextFromJsonValue(value.message);
  if (value.result) return extractTextFromJsonValue(value.result);
  if (value.output) return extractTextFromJsonValue(value.output);
  if (value.data) return extractTextFromJsonValue(value.data);
  return undefined;
}
