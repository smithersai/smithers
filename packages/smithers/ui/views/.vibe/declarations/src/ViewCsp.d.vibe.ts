/**
 * The frame a generated view shows in, written by the trusted page and never
 * by the model.
 *
 * A view's HTML never runs as script. The page shows it in
 * `<iframe sandbox="allow-scripts" srcdoc>`: an opaque origin with no cookies,
 * storage or parent DOM. The frame's document carries a Content Security
 * Policy whose only script is the page's own runtime, pinned by its SHA-256
 * hash, and it forbids inline event handlers, every network fetch, plugins,
 * nested frames, workers, `<base>` and form submission.
 *
 * The runtime asks the page for the view's HTML over the bridge (see
 * `Bridge`), parses it inertly and copies only allowlisted elements and
 * attributes into the document. This module writes the document around it.
 *
 * @since 0.1.0
 */
import type * as Bridge from "./Bridge.vibe";
/**
 * The frame's `sandbox` attribute: scripts for the page's runtime, and
 * nothing else. No `allow-same-origin`, `allow-forms`, `allow-popups`,
 * `allow-downloads`, `allow-modals` or `allow-top-navigation`.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const sandbox = "allow-scripts";
/**
 * The attribute on the frame document's `<html>` element that carries the
 * per-mount nonce for `ui/initialize`.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const nonceAttribute = "data-smithers-nonce";
/**
 * A script's CSP source expression: `'sha256-<base64>'` over its UTF-8 text.
 *
 * @category hashing
 * @since 0.1.0
 */
export declare const hash: (script: string) => string;
/**
 * The frame's policy for a runtime with the given {@link hash}.
 *
 * `script-src-attr 'none'` blocks inline event handlers even where a
 * sanitizer missed one. `style-src 'unsafe-inline'` admits the page's theme
 * sheet and React's `style` attributes; `img-src` and `font-src` admit only
 * `data:` URLs, so nothing in a view reaches the network.
 *
 * @category policies
 * @since 0.1.0
 */
export declare const policy: (runtimeHash: string) => string;
/**
 * The inputs of one frame document.
 *
 * - `runtime`: the page's frame runtime, as one classic script;
 * - `nonce`: this mount's secret for `ui/initialize`;
 * - `theme`: the theme the document starts in;
 * - `styles`: the page's own style sheet, such as the component library's.
 *
 * @category models
 * @since 0.1.0
 */
export interface FrameDocumentOptions {
    readonly runtime: string;
    readonly nonce: string;
    readonly theme: Bridge.Theme;
    readonly styles: string;
}
/**
 * The frame's `srcdoc`: the policy, the page's styles and the runtime, and no
 * view content. The view's HTML arrives later over the bridge. The runtime is
 * the body's only child, so the body exists when it runs.
 *
 * The runtime is hashed exactly as it is written into the document, after any
 * `</script` in it is escaped, so the policy always admits it.
 *
 * @category documents
 * @since 0.1.0
 */
export declare const frameDocument: (options: FrameDocumentOptions) => string;
