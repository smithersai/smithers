/**
 * Moving focus among a list's items by key (`NoticeKeyAction`'s moves): the
 * toast stack's toasts and the notifications panel's entries. DOM only.
 */
import type { NoticeKeyAction } from "./notices";

/**
 * Focuses the next, previous, first or last of `selector`'s matches inside
 * `container`, counting from the one that is or holds `from`, including siblings inside
 * its optional `itemContainer`. Returns whether
 * `action` was a move and an item took focus; any other action, or a list with
 * no items, moves nothing.
 */
export const moveFocus = (container: Element, selector: string, action: NoticeKeyAction, from: Element | null, itemContainer?: string): boolean => {
  if (action !== "next" && action !== "previous" && action !== "first" && action !== "last") return false;
  const items = [...container.querySelectorAll<HTMLElement>(selector)];
  if (items.length === 0) return false;
  const at = items.findIndex((item) => from !== null && (item === from || item.contains(from) || (itemContainer !== undefined && item.closest(itemContainer)?.contains(from))));
  const index = action === "first"
    ? 0
    : action === "last"
    ? items.length - 1
    : action === "next"
    ? Math.min(at + 1, items.length - 1)
    : Math.max(at - 1, 0);
  items[index]!.focus();
  return true;
};
