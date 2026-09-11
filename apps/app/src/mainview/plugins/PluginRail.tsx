import { BookOpen, Box, Compass, Factory, History, KeyRound, Library, Puzzle, RadioTower } from "lucide-react"
import type { ReactNode } from "react"
import type { PluginIcon, RailEntry } from "./AppPlugin"

/*
 * What the installed plugins put on the workspace: one button per rail entry,
 * each bound to the flow the plugin named. The entries are the loader's
 * output, not a list written here, so removing a plugin takes its buttons
 * with it and a plugin loaded later can reorder them.
 */

const GLYPHS: Readonly<Record<PluginIcon, ReactNode>> = {
  "book-open": <BookOpen size={16} aria-hidden="true" />,
  history: <History size={16} aria-hidden="true" />,
  library: <Library size={16} aria-hidden="true" />,
  "radio-tower": <RadioTower size={16} aria-hidden="true" />,
  "key-round": <KeyRound size={16} aria-hidden="true" />,
  box: <Box size={16} aria-hidden="true" />,
  factory: <Factory size={16} aria-hidden="true" />,
  compass: <Compass size={16} aria-hidden="true" />,
  puzzle: <Puzzle size={16} aria-hidden="true" />
}

export function PluginRail({
  entries,
  onOpen,
  children
}: {
  readonly entries: ReadonlyArray<RailEntry>
  /** Bound by the caller to the registry: every entry runs its own flow. */
  readonly onOpen: (flow: string) => void
  readonly children?: ReactNode
}) {
  return (
    <nav className="plugin-rail" aria-label="Installed capabilities">
      {entries.map((entry) => (
        <button
          key={entry.flow}
          type="button"
          data-flow={entry.flow}
          data-testid={`plugin-rail-${entry.flow}`}
          onClick={() => onOpen(entry.flow)}
        >
          {GLYPHS[entry.icon]}
          {entry.label}
        </button>
      ))}
      {children}
    </nav>
  )
}
