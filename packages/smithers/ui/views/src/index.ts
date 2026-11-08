/**
 * Generated views as safe arbitrary output.
 *
 * A renderer agent writes a TSX module. {@link ViewCode} checks and compiles
 * it, {@link PresentationRealm} renders it to HTML inside a QuickJS realm with
 * a presentation bundle built from {@link Presentation}, and a trusted page
 * shows the HTML in a frame {@link ViewCsp} writes. The frame talks back over
 * the {@link Bridge}, sending only the events the module's
 * {@link Interactions} declare. {@link Home} reads the blocks a repository
 * declares as its own home, which a page draws from data, and {@link Docs}
 * the docs index a home names. {@link WebPage}
 * asks, from a server, whether an outside page shows in a frame, and reads
 * the card shown in its place.
 *
 * @since 0.1.0
 */

/**
 * @category messaging
 * @since 0.1.0
 */
export * as Bridge from "./Bridge.vibe"

/**
 * @category homes
 * @since 0.1.0
 */
export * as Docs from "./Docs.vibe"

/**
 * @category homes
 * @since 0.1.0
 */
export * as Home from "./Home.vibe"

/**
 * @category messaging
 * @since 0.1.0
 */
export * as Interactions from "./Interactions.vibe"

/**
 * @category rendering
 * @since 0.1.0
 */
export * as Presentation from "./Presentation.ts"

/**
 * @category rendering
 * @since 0.1.0
 */
export * as PresentationRealm from "./PresentationRealm.vibe"

/**
 * @category checking
 * @since 0.1.0
 */
export * as ViewCode from "./ViewCode.ts"

/**
 * @category framing
 * @since 0.1.0
 */
export * as ViewCsp from "./ViewCsp.vibe"

/**
 * @category framing
 * @since 0.1.0
 */
export * as WebPage from "./WebPage.vibe"
