import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"

const directory = process.argv[2]
if (!directory || process.argv.length !== 3) throw new Error("Usage: bun scripts/cutover/keys.ts PRIVATE_DIRECTORY")
mkdirSync(directory, { mode: 0o700 })
const pair = generateKeyPairSync("rsa", { modulusLength: 3072 })
const publicJwk = pair.publicKey.export({ format: "jwk" })
const material = { migrationId: randomUUID(), token: randomBytes(32).toString("base64url"),
  expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), publicJwk,
  privateJwk: pair.privateKey.export({ format: "jwk" }) }
writeFileSync(resolve(directory, "recipient.json"), JSON.stringify(material), { mode: 0o600, flag: "wx" })
// Feed this file to the temporary deployment's secret-binding API over stdin;
// the private key is deliberately absent. Never pass these values as CLI args.
writeFileSync(resolve(directory, "bindings.json"), JSON.stringify({
  SMITHERS_EXPORT_TOKEN: material.token, SMITHERS_EXPORT_RECIPIENT: JSON.stringify(publicJwk), SMITHERS_EXPORT_EXPIRES_AT: material.expiresAt
}), { mode: 0o600, flag: "wx" })
console.log("Export key files created; values withheld")
