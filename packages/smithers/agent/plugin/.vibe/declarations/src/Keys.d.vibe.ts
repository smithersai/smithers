/**
 * The closed key grammar a keybinding declares, and matching pressed keys
 * against it.
 *
 * A binding is one or two strokes separated by one space (`g q`). A stroke is
 * any of `mod+`, `ctrl+`, `alt+`, `shift+` followed by a key: `a`–`z`,
 * `0`–`9`, `digit` (any of `1`–`9`), `enter`, `escape`, `tab`, `space`, the
 * four arrows, `/`, `?`, `[` or `]`. `mod` is Meta on a Mac and Control
 * elsewhere.
 *
 * @since 1.1.0
 */
import * as Result from "effect/Result";
/**
 * One stroke of a binding.
 *
 * @category models
 * @since 1.1.0
 */
export interface Stroke {
    readonly key: string;
    readonly mod: boolean;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
}
/**
 * A parsed binding: one or two strokes.
 *
 * @category models
 * @since 1.1.0
 */
export interface Keys {
    readonly strokes: ReadonlyArray<Stroke>;
}
/**
 * A key the person pressed, as a `KeyboardEvent` reports it: `key` is
 * `KeyboardEvent.key` (case is ignored), the rest its modifier flags.
 *
 * @category models
 * @since 1.1.0
 */
export interface Pressed {
    readonly key: string;
    readonly meta: boolean;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
}
/**
 * How pressed keys compare with a binding. `matched` when every stroke was
 * pressed, `partial` when the pressed strokes are a proper prefix of it, and
 * `index` the digit pressed less one when the matching stroke is `digit`.
 *
 * @category models
 * @since 1.1.0
 */
export interface Match {
    readonly matched: boolean;
    readonly partial: boolean;
    readonly index?: number;
}
/**
 * Matching options: `mac` maps `mod` to Meta, otherwise to Control.
 *
 * @category models
 * @since 1.1.0
 */
export interface Options {
    readonly mac: boolean;
}
/**
 * Parses a binding, or says why it is outside the grammar.
 *
 * @category parsing
 * @since 1.1.0
 */
export declare const parse: (text: string) => Result.Result<Keys, string>;
/**
 * Compares the strokes pressed since the keymap last reset with a binding.
 *
 * @category matching
 * @since 1.1.0
 */
export declare const match: (keys: Keys, pressed: ReadonlyArray<Pressed>, options: Options) => Match;
