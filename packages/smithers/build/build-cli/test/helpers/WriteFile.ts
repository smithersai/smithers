import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/** Writes `text` to `relative` under `root`, creating the parent directories. */
export const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}
