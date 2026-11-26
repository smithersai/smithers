import type { Row } from "../../src/features/transcript/schema.ts"

// SQLite replay is synchronous. An invalid stored body still fails the read with the JSON parser's error.
export const parseStoredUpdate = (body: string): Row["update"] => JSON.parse(body)
