const flowNames: Readonly<Record<string, string>> = { ci: "CI", todo: "TODO", "watch/set": "Follow" }
/** Known system flows have product names; a person's own flow keeps its name. */
export const flowWords = (name: string): string => flowNames[name] ?? name
/** Git ref prefixes are transport details, not part of a branch name. */
export const branchWords = (ref: string): string => ref.replace(/^refs\/heads\//, "")
