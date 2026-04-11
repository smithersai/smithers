export function normalizeInputRow(input: any) {
  if (!input || typeof input !== "object") return input;
  if (!("payload" in input)) return input;
  const keys = Object.keys(input);
  const payloadOnly = keys.every((key) => key === "runId" || key === "payload");
  if (!payloadOnly) return input;
  const payload = input.payload;
  if (payload == null) return {};
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}
