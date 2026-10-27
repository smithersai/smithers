import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

// The legacy bug door is a noindex redirect into the app, so it is not a sitemap page.
const root = process.argv[2]
for (const name of await readdir(root)) {
  if (!/^sitemap-\d+\.xml$/.test(name)) continue
  const file = join(root, name)
  const xml = await readFile(file, "utf8")
  const entries = [...xml.matchAll(/<url>.*?<\/url>/gs)]
  let filtered = xml
  for (const [entry] of entries) {
    const location = /<loc>(.*?)<\/loc>/.exec(entry)[1]
    if (new URL(location).pathname.replace(/\/$/, "") === "/bug") filtered = filtered.replace(entry, "")
  }
  await writeFile(file, filtered)
}
