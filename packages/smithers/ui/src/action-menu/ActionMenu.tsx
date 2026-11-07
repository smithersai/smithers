/** @jsxImportSource react */
import { type ReactNode, useRef, useState } from "react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { Button, type ButtonProps } from "../button";
import { cn } from "@smthrs/ui-css";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../dialog";
import { useInjectUiCss } from "../styles";

/** What a person confirms before an action runs: the dialog's title, an optional line under it, and its button. */
export type ActionConfirm = {
  readonly title: string;
  readonly description?: string;
  /** The confirming button's words, such as `Drop`. */
  readonly action: string;
};

/** One action in an `ActionMenu`. */
export type ActionMenuItem = {
  readonly label: string;
  readonly onSelect: () => void;
  /** Colors the item, and its confirming button, as a destructive action. */
  readonly destructive?: boolean;
  /** Asks first, in a dialog whose Cancel holds the focus; absent: the item runs at once. */
  readonly confirm?: ActionConfirm;
};

/** The confirm dialog's body: title, description, Cancel (focused first) and the action. */
function ConfirmBody({
  confirm,
  destructive,
  onConfirm,
}: {
  readonly confirm: ActionConfirm;
  readonly destructive: boolean;
  readonly onConfirm: () => void;
}) {
  return (
    <DialogContent showCloseButton={false} data-slot="action-confirm">
      <DialogHeader>
        <DialogTitle>{confirm.title}</DialogTitle>
        {confirm.description === undefined ? null : <DialogDescription>{confirm.description}</DialogDescription>}
      </DialogHeader>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost" autoFocus>
            Cancel
          </Button>
        </DialogClose>
        <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
          {confirm.action}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** The `⋯` glyph a menu's trigger shows. */
const dots = (
  <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="3.5" cy="8" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="12.5" cy="8" r="1.4" />
  </svg>
);

export type ActionMenuProps = Omit<ButtonProps, "children" | "onSelect"> & {
  /** The trigger's accessible name, such as `T4 actions`. */
  label: string;
  items: ReadonlyArray<ActionMenuItem>;
};

/**
 * A quiet `⋯` button that opens a menu of actions, as a row of GitHub's lists
 * does. Enter, Space and ArrowDown open it on its first item; Escape closes it.
 * An item with `confirm` asks in a dialog first, with Cancel focused, and runs
 * only on the dialog's action; focus then returns to the trigger.
 */
export function ActionMenu({ label, items, className, ...props }: ActionMenuProps) {
  useInjectUiCss();
  const trigger = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<ActionMenuItem | null>(null);
  return (
    <>
      <MenuPrimitive.Root modal={false}>
        <MenuPrimitive.Trigger asChild>
          <Button
            ref={trigger}
            variant="ghost"
            size="icon"
            aria-label={label}
            data-slot="action-menu-trigger"
            className={cn("sui-action-menu-trigger", className)}
            {...props}
          >
            {dots}
          </Button>
        </MenuPrimitive.Trigger>
        <MenuPrimitive.Portal>
          <MenuPrimitive.Content align="end" sideOffset={4} data-slot="action-menu" className="sui-action-menu">
            {items.map((item) => (
              <MenuPrimitive.Item
                key={item.label}
                className="sui-action-menu-item"
                data-destructive={item.destructive || undefined}
                onSelect={() => (item.confirm === undefined ? item.onSelect() : setAsking(item))}
              >
                {item.label}
              </MenuPrimitive.Item>
            ))}
          </MenuPrimitive.Content>
        </MenuPrimitive.Portal>
      </MenuPrimitive.Root>
      <Dialog open={asking !== null} onOpenChange={(open) => (open ? undefined : setAsking(null))}>
        {asking?.confirm === undefined ? null : (
          <ConfirmBody
            confirm={asking.confirm}
            destructive={asking.destructive === true}
            onConfirm={() => {
              setAsking(null);
              trigger.current?.focus();
              asking.onSelect();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

export type ConfirmButtonProps = Omit<ButtonProps, "onClick" | "children"> & {
  children: ReactNode;
  confirm: ActionConfirm;
  /** Runs once the person presses the dialog's action. */
  onConfirm: () => void;
  /** Colors the dialog's action as destructive. */
  destructive?: boolean;
};

/**
 * A button that asks before it acts: pressing it opens the same dialog an
 * `ActionMenu` item with `confirm` opens, Cancel focused, and `onConfirm` runs
 * only on the dialog's action.
 */
export function ConfirmButton({ children, confirm, onConfirm, destructive = false, ...props }: ConfirmButtonProps) {
  useInjectUiCss();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-slot="confirm-button" {...props}>
          {children}
        </Button>
      </DialogTrigger>
      {open ? (
        <ConfirmBody
          confirm={confirm}
          destructive={destructive}
          onConfirm={() => {
            setOpen(false);
            onConfirm();
          }}
        />
      ) : null}
    </Dialog>
  );
}
