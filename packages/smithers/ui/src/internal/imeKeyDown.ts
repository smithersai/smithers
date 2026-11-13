import type { KeyboardEvent } from "react";

/** Includes Safari's confirmation keydown after compositionend has cleared isComposing. */
export const isImeKeyDown = (event: Pick<KeyboardEvent, "nativeEvent">): boolean =>
  event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
