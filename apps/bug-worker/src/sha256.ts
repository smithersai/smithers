/** Lowercase hex SHA-256 of a UTF-8 string; keys subscriber records and provider idempotency keys. */
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
