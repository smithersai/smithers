/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { personInitial, personLane } from "./internal/person";
import { useInjectUiCss } from "./styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/** One person shown in an {@link AvatarStack}. */
export interface AvatarStackPerson {
  /** A stable key; it also picks the person's color. */
  readonly id: string;
  /** Such as a GitHub login. The avatar shows its initial and is named by it. */
  readonly name: string;
  /** The tooltip, such as "maya · Terminal". Defaults to the name. */
  readonly title?: string;
}

export type AvatarStackProps = Omit<ComponentProps<"ul">, "children" | "onSelect"> & {
  readonly people: ReadonlyArray<AvatarStackPerson>;
  /** How many avatars show before the rest fold into one `+N`. Defaults to 4. */
  readonly max?: number;
  /** When given, each avatar is a button that follows its person by click, Enter or Space. */
  readonly onSelect?: (id: string) => void;
  /** The list's accessible name. Defaults to "People here". */
  readonly label?: string;
};

const DEFAULT_MAX = 4;

/**
 * Presence avatars, as in a Google Docs or Figma header: overlapping circles
 * with each person's initial on a color fixed by their id, a tooltip with
 * their `title`, and one `+N` whose tooltip names the rest (it takes focus, so
 * a keyboard reaches that tooltip too). Renders nothing for no people.
 */
export function AvatarStack({
  people,
  max = DEFAULT_MAX,
  onSelect,
  label = "People here",
  className,
  ...props
}: AvatarStackProps) {
  useInjectUiCss();
  if (people.length === 0) return null;
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : DEFAULT_MAX;
  const shown = people.slice(0, limit);
  const rest = people.slice(limit);
  const restNames = rest.map((person) => person.name).join(", ");
  return (
    <TooltipProvider>
      <ul data-slot="avatar-stack" className={cn("sui-avatar-stack", className)} aria-label={label} {...props}>
        {shown.map((person) => (
          <li key={person.id}>
            <Tooltip>
              <TooltipTrigger asChild>
                {onSelect === undefined ?
                  (
                    <span role="img" aria-label={person.name} className="sui-avatar" data-slot="avatar" data-lane={personLane(person.id)}>
                      {personInitial(person.name)}
                    </span>
                  ) :
                  (
                    <button
                      type="button"
                      aria-label={person.name}
                      className="sui-avatar"
                      data-slot="avatar"
                      data-lane={personLane(person.id)}
                      onClick={() => onSelect(person.id)}
                    >
                      {personInitial(person.name)}
                    </button>
                  )}
              </TooltipTrigger>
              <TooltipContent>{person.title ?? person.name}</TooltipContent>
            </Tooltip>
          </li>
        ))}
        {rest.length === 0 ? null : (
          <li>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  tabIndex={0}
                  aria-label={restNames}
                  className="sui-avatar sui-avatar-more"
                  data-slot="avatar-more"
                >
                  +{rest.length}
                </span>
              </TooltipTrigger>
              <TooltipContent>{restNames}</TooltipContent>
            </Tooltip>
          </li>
        )}
      </ul>
    </TooltipProvider>
  );
}
