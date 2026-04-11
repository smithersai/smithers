import { SmithersError } from "../errors/index";

export function assertMaxBytes(
  field: string,
  value: string | ArrayBuffer | ArrayBufferView,
  maxBytes: number,
): number {
  let actualBytes: number;
  if (typeof value === "string") {
    actualBytes = Buffer.byteLength(value, "utf8");
  } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    actualBytes = value.byteLength;
  } else {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be a string or byte buffer.`,
      { field, valueType: typeof value },
    );
  }

  if (actualBytes > maxBytes) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} exceeds the maximum size of ${maxBytes} bytes.`,
      { field, maxBytes, actualBytes },
    );
  }

  return actualBytes;
}
