/** Build the complete product gateway; target repositories install no packages. */
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bundle } from "../coding/build.mjs"
export const buildProductHost = async (outfile) => {
  await bundle(fileURLToPath(new URL("./serve.ts", import.meta.url)), outfile)
  const bytes = await readFile(outfile)
  const digest = createHash("sha256").update(bytes).digest("hex")
  await writeFile(`${outfile}.sha256`, `${digest}  ${outfile.split("/").pop()}\n`)
  return digest
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outfile = resolve(process.argv[2] ?? "dist/product-host/smithers.mjs")
  console.log(JSON.stringify({ path: outfile, sha256: await buildProductHost(outfile) }))
}
