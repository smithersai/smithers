type FileRow = {
  path: string
  extension: string
}

export type StructuredOutputSection =
  | {
      title: string
      kind: "paragraph"
      text: string
    }
  | {
      title: string
      kind: "bullets"
      items: string[]
    }
  | {
      title: string
      kind: "files"
      files: FileRow[]
    }

export type StructuredOutputCard = {
  id: string
  title: string
  sections: StructuredOutputSection[]
}

export type StructuredOutputJsonObject = Record<string, unknown>
export type InlineTextSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>
    const keys = Object.keys(objectValue).sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
      .join(",")}}`
  }

  return JSON.stringify(value) ?? "null"
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function stringifyUnknownValue(value: unknown) {
  if (typeof value === "string") {
    return value
  }

  try {
    return JSON.stringify(value, null, 2) ?? "null"
  } catch {
    return String(value)
  }
}

function parseFileRow(value: string): FileRow | null {
  const raw = value.trim()
  if (!raw) {
    return null
  }

  const withoutFragment = raw.split("#")[0] ?? raw
  const withoutLineInfo = withoutFragment.replace(/:\d+(?::\d+)?$/, "")
  if (!withoutLineInfo.includes(".")) {
    return null
  }

  const extensionMatch = withoutLineInfo.match(/\.([a-z0-9]{1,12})$/i)
  if (!extensionMatch) {
    return null
  }

  return {
    path: raw,
    extension: extensionMatch[1]!.toLowerCase(),
  }
}

function normalizeSectionTitle(key: string) {
  const withWordBoundaries = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!withWordBoundaries || withWordBoundaries === key) {
    return key
  }

  return withWordBoundaries
    .split(" ")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

function classifySection(title: string, value: unknown): StructuredOutputSection | null {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    return {
      title,
      kind: "paragraph",
      text: value,
    }
  }

  if (Array.isArray(value) && value.length === 0) {
    return null
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    const items = value.map((entry) => entry.trim()).filter(Boolean)
    if (items.length === 0) {
      return null
    }

    const fileRows = items.map((entry) => parseFileRow(entry))
    const everyItemIsFile = items.length > 0 && fileRows.every((entry) => entry !== null)

    if (everyItemIsFile) {
      return {
        title,
        kind: "files",
        files: fileRows as FileRow[],
      }
    }

    return {
      title,
      kind: "bullets",
      items,
    }
  }

  return {
    title,
    kind: "paragraph",
    text: stringifyUnknownValue(value),
  }
}

function extractJsonObjectStrings(value: string) {
  const objectStrings: string[] = []
  let depth = 0
  let startIndex = -1
  let inString = false
  let isEscaped = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]

    if (inString) {
      if (isEscaped) {
        isEscaped = false
      } else if (character === "\\") {
        isEscaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }

    if (character === "{") {
      if (depth === 0) {
        startIndex = index
      }
      depth += 1
      continue
    }

    if (character !== "}" || depth === 0) {
      continue
    }

    depth -= 1
    if (depth !== 0 || startIndex === -1) {
      continue
    }

    const candidate = value.slice(startIndex, index + 1).trim()
    if (candidate) {
      objectStrings.push(candidate)
    }
    startIndex = -1
  }

  return objectStrings
}

export function extractStructuredOutputProseText(value: string) {
  let proseText = value
  const objectStrings = extractJsonObjectStrings(value)

  for (const objectString of objectStrings) {
    const escapedObjectString = escapeRegExp(objectString)
    const fencedJsonPattern = new RegExp("```json\\s*" + escapedObjectString + "\\s*```", "g")
    const fencedPattern = new RegExp("```\\s*" + escapedObjectString + "\\s*```", "g")
    const plainPattern = new RegExp(escapedObjectString, "g")

    proseText = proseText.replace(fencedJsonPattern, "")
    proseText = proseText.replace(fencedPattern, "")
    proseText = proseText.replace(plainPattern, "")
  }

  return proseText
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
}

export function parseStructuredOutputCards(value: string): StructuredOutputCard[] {
  const parsedObjects = parseStructuredOutputJsonObjects(value)
  const cards: StructuredOutputCard[] = []
  for (const objectValue of parsedObjects) {
    const sections = Object.entries(objectValue)
      .map(([key, entryValue]) => classifySection(normalizeSectionTitle(key), entryValue))
      .filter((section): section is StructuredOutputSection => section !== null)

    if (sections.length === 0) {
      continue
    }

    cards.push({
      id: `message-${cards.length + 1}`,
      title: `Message ${cards.length + 1}`,
      sections,
    })
  }

  return cards
}

export function parseStructuredOutputJsonObjects(value: string): StructuredOutputJsonObject[] {
  const objectStrings = extractJsonObjectStrings(value)
  const uniqueObjects = new Set<string>()
  const parsedObjects: StructuredOutputJsonObject[] = []

  for (const objectString of objectStrings) {
    try {
      const parsed = JSON.parse(objectString)
      const objectValue = asObject(parsed)
      if (!objectValue) {
        continue
      }

      const dedupeKey = stableStringify(objectValue)
      if (uniqueObjects.has(dedupeKey)) {
        continue
      }

      uniqueObjects.add(dedupeKey)
      parsedObjects.push(objectValue)
    } catch {
      continue
    }
  }

  return parsedObjects
}

export function parseInlineCodeSegments(value: string): InlineTextSegment[] {
  const segments: InlineTextSegment[] = []
  let cursor = 0

  while (cursor < value.length) {
    const openingTickIndex = value.indexOf("`", cursor)
    if (openingTickIndex === -1) {
      const trailingText = value.slice(cursor)
      if (trailingText) {
        segments.push({ kind: "text", text: trailingText })
      }
      break
    }

    const closingTickIndex = value.indexOf("`", openingTickIndex + 1)
    if (closingTickIndex === -1) {
      const trailingText = value.slice(cursor)
      if (trailingText) {
        segments.push({ kind: "text", text: trailingText })
      }
      break
    }

    const plainText = value.slice(cursor, openingTickIndex)
    if (plainText) {
      segments.push({ kind: "text", text: plainText })
    }

    const codeText = value.slice(openingTickIndex + 1, closingTickIndex)
    segments.push({ kind: "code", text: codeText })
    cursor = closingTickIndex + 1
  }

  if (segments.length === 0) {
    return [{ kind: "text", text: value }]
  }

  return segments
}
