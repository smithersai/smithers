import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseScripts } from "./scripts.mjs"
/** Markdown is the script source; only validated recording IDs become asset paths. */
export function recordings() {
  return (tree, file) => {
    const docs = fileURLToPath(new URL("../../tui/docs/", import.meta.url))
    const walk = (node) => {
      if (node.type === "link" && /\.md(?:#.*)?$/.test(node.url) && !/^(https?:|\/\/)/.test(node.url)) {
        const [path, hash] = node.url.split("#")
        const target = relative(docs, resolve(dirname(file.path), path))
        if (!target.startsWith("..")) {
          node.url = "/" + target.replace(/README\.md$/i, "").replace(/\.md$/, "/").toLowerCase() +
            (hash ? "#" + hash : "")
        }
      }
      if (!node.children) return
      node.children = node.children.map((child) => {
        if (child.type === "code" && child.lang === "tui-script") {
          const [script] = parseScripts(`\x60\x60\x60tui-script ${child.meta ?? ""}\n${child.value}\n\x60\x60\x60`)
          const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;")
          const alt = script.steps.filter((step) => step.kind === "Capture").at(-1)?.value ?? script.id
          return {
            type: "html",
            value:
              `<figure class="recording"><picture><source media="(prefers-reduced-motion: reduce)" srcset="/recordings/${script.id}.png"><img src="/recordings/${script.id}.gif" alt="${
                escape(alt)
              }" loading="lazy" width="880" height="480"></picture><figcaption><a href="/recordings/${script.id}.txt">Read recording transcript</a></figcaption></figure>`
          }
        }
        walk(child)
        return child
      })
    }
    walk(tree)
  }
}
