import { readFileSync } from "node:fs"
import { type Artifact, verify } from "../soakArtifact.ts"

const path = process.argv[2]
const minimumMinutes = Number(process.argv[3])
if (!path) throw new Error("Usage: node test/fixtures/verify-soak.ts artifact.json minimum-minutes")
verify(JSON.parse(readFileSync(path, "utf8")) as Artifact, { minimumMinutes })
process.stdout.write("Soak artifact verified\n")
