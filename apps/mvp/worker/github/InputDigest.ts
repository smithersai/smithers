import { digestSync } from "@smthrs/crypto"

/** What the decision reads of an issue, digested: an edit to its title or body after the read drops the decision. */
export const inputDigest = (title: string, body: string | null) => digestSync(JSON.stringify([title, body ?? ""]))
