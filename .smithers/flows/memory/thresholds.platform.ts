// The platform code of thresholds.vibe: the thresholds file and its receipt on Node's filesystem.
import * as MemoryCalibration from "@smthrs/agent/MemoryCalibration"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** The receipt of the fit that wrote the thresholds file, relative to the repository root. */
export const receiptFile = ".smithers/memory-thresholds.receipt.json"

/**
 * `root`'s thresholds file.
 * @throws {never}
 */
export function thresholdsPath(root: string): string {
  return join(root, MemoryCalibration.file)
}

/** The thresholds file's text, or `undefined` when there is no such file; any other read failure rejects. */
export const readThresholds = async (root: string): Promise<string | undefined> => {
  try {
    return await readFile(thresholdsPath(root), "utf8")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
}

/** Writes the thresholds and the receipt under `root`, creating `.smithers` when it is missing. */
export const writeThresholds = async (root: string, thresholds: string, receipt: string): Promise<void> => {
  await mkdir(join(root, ".smithers"), { recursive: true })
  await writeFile(thresholdsPath(root), thresholds)
  await writeFile(join(root, receiptFile), receipt)
}
