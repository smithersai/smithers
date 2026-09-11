import type { Ref, RefCallback } from "react";

/**
 * Merges several refs into one callback ref, so a component can keep the ref
 * its behavior reads while still handing the element to a caller's ref.
 */
export function composeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    }
  };
}
