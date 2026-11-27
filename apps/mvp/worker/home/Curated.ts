import { Home } from "@smthrs/views"
import type { Section } from "../../src/features/home/schema.ts"
import effect from "./curated/effect-ts-effect.json"
import smithers from "./curated/smithersai-smithers.json"
import vibelang from "./curated/smithersai-vibelang.json"
import zevm from "./curated/evmts-zevm.json"

// Smithers' own homes for repositories that declare none (docs/features/home.md#curated-homes): data kept in this
// directory, one JSON file per repository, in the very format a repository commits as `.smithers/home.json` under
// `home`. Nothing here is code a page runs: ChatApi reads a file with `Home.read`, as a page reads a repository's own,
// and answers only the sections the asker's audience may see (worker/home/Api.ts). When the plugin host lands
// (decision 0017), each file becomes a first-party plugin's `repo/home` tap.

/** One curated home as its file holds it: the repository, its default branch, and the home document. */
export interface CuratedFile {
  readonly repository: string
  readonly defaultBranch: string
  readonly home: unknown
}

/** A curated home as ChatApi answers it: its default branch, every section, read, and who counts as a contributor. */
export interface CuratedHome {
  readonly defaultBranch: string
  readonly sections: ReadonlyArray<Section>
  readonly contributors: Home.Contributors
  /** The docs index it names (`Home.DocsUrl`); absent when it names none. */
  readonly docs?: string
}

/** Every curated file, in one list. */
export const files: ReadonlyArray<CuratedFile> = [smithers, vibelang, zevm, effect]

/** A repository's key as GitHub compares names: without case. */
const keyOf = (owner: string, name: string): string => `${owner}/${name}`.toLowerCase()

/**
 * The curated home for `owner/name`: `undefined` when Smithers has none; `"invalid"` when its file doesn't read as a
 * home, so ChatApi says so in its records rather than draw half of one.
 */
export const find = (
  owner: string,
  name: string,
  from: ReadonlyArray<CuratedFile> = files,
): CuratedHome | "invalid" | undefined => {
  const file = from.find((each) => each.repository.toLowerCase() === keyOf(owner, name))
  if (file === undefined) return undefined
  const read = Home.read(JSON.stringify(file.home))
  return read._tag === "Declared" && read.skipped === 0
    ? {
      defaultBranch: file.defaultBranch,
      sections: read.sections,
      contributors: read.contributors,
      ...(read.docs === undefined ? {} : { docs: read.docs }),
    }
    : "invalid"
}
