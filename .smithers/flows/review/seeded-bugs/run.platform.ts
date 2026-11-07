import { fileURLToPath as $fileURLToPath } from "node:url"
import { dirname as $dirname } from "node:path"
export function $importMetaFilename(url: string): ImportMeta["filename"] { return (url.startsWith("file:") ? $fileURLToPath(url) : undefined) as ImportMeta["filename"] }
export function $importMetaDirname(url: string): ImportMeta["dirname"] { return (url.startsWith("file:") ? $dirname($fileURLToPath(url)) : undefined) as ImportMeta["dirname"] }
