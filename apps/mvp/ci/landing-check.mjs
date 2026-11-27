import { fileURLToPath } from "node:url"
import { checkNumbers } from "../../../.smithers/flows/land/numbering.mjs"

checkNumbers(fileURLToPath(new URL("../../../", import.meta.url)))
console.log("Decision numbers, migration numbers and migration registration passed.")
