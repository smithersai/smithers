// TEMP: delete this file and import the component from @smthrs/ui once that
// package exports one.
/**
 * A pickable template tile: title, then a two-line description.
 *
 * Built on `Card` from @smthrs/ui so the surface, border, and radius stay on
 * the house tokens; only the button behavior and the line clamp are added
 * here. The upstream tile carries no category chip, so neither does this one.
 */
import { Card, CardDescription, CardHeader, CardTitle } from "@smthrs/ui"

export interface TemplateCardProps {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly selected?: boolean
  readonly onSelect: (id: string) => void
}

export function TemplateCard({ id, title, description, selected = false, onSelect }: TemplateCardProps) {
  return (
    <button
      type="button"
      className="aomi-template-card"
      // The tile's name is the template title. Without this the name is
      // computed from the card's contents, which reads the description out too.
      aria-label={title}
      data-selected={selected ? "true" : undefined}
      onClick={() => onSelect(id)}
    >
      <Card className="aomi-template-card-surface">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardDescription>{description}</CardDescription>
      </Card>
    </button>
  )
}
