/** @jsxImportSource react */
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@smthrs/ui-css";
import { Dialog, DialogOverlay, DialogPortal } from "./dialog";

export type CommandPaletteItem = {
  id: string;
  label: ReactNode;
  /** Trailing faint text, such as a path. */
  detail?: ReactNode;
  /** Leading chip, such as a kind. */
  badge?: ReactNode;
};

export type CommandPaletteProps = {
  open: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  items: ReadonlyArray<CommandPaletteItem>;
  /** The highlighted item's index; no item is highlighted when it is out of range. */
  highlighted: number;
  /** Called by ArrowUp and ArrowDown with the index clamped to `items`. */
  onHighlight: (index: number) => void;
  /** Called by Enter on the highlighted item and by a click on any item. */
  onChoose: (id: string) => void;
  /** Called by Escape and by a click on the backdrop. */
  onClose: () => void;
  placeholder?: string;
  footer?: ReactNode;
  /** Names the dialog, the search box and the list. Defaults to "Command palette". */
  "aria-label"?: string;
  className?: string;
};

/** Keeps the highlighted row in view as it moves. A ref callback, so it runs only when the row changes. */
function scrollIntoNearest(row: HTMLDivElement | null): void {
  row?.scrollIntoView?.({ block: "nearest" });
}

/**
 * A modal search list over a Radix Dialog. Stateless: the host owns the query,
 * the items and the highlighted index, and this calls back for each change.
 * The input is a `combobox` whose `aria-activedescendant` is the highlighted
 * `option`.
 */
export function CommandPalette({
  open,
  query,
  onQueryChange,
  items,
  highlighted,
  onHighlight,
  onChoose,
  onClose,
  placeholder,
  footer,
  "aria-label": label = "Command palette",
  className,
}: CommandPaletteProps) {
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;
  const active = items[highlighted] === undefined ? undefined : optionId(highlighted);
  const clamp = (index: number) => Math.max(0, Math.min(index, items.length - 1));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length > 0) onHighlight(clamp(highlighted + (event.key === "ArrowDown" ? 1 : -1)));
      return;
    }
    if (event.key !== "Enter") return;
    const item = items[highlighted];
    if (item === undefined) return;
    event.preventDefault();
    onChoose(item.id);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-slot="command-palette"
          className={cn("sui-command-palette", className)}
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sui-sr-only">{label}</DialogPrimitive.Title>
          <input
            className="sui-command-palette-input"
            role="combobox"
            aria-label={label}
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <div id={listId} role="listbox" aria-label={label} className="sui-command-palette-list">
            {items.map((item, index) => (
              <div
                key={item.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === highlighted}
                className="sui-command-palette-option"
                ref={index === highlighted ? scrollIntoNearest : undefined}
                // Keep focus in the input, so the keys keep working after a click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChoose(item.id)}
              >
                {item.badge === undefined ? null : <span className="sui-command-palette-badge">{item.badge}</span>}
                <span className="sui-command-palette-label">{item.label}</span>
                {item.detail === undefined ? null : <span className="sui-command-palette-detail">{item.detail}</span>}
              </div>
            ))}
          </div>
          {footer === undefined ? null : <div className="sui-command-palette-footer">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
