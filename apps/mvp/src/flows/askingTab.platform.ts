// The platform side of src/flows/askingTab.vibe: the page's or the worker's `crypto`.

/**
 * A fresh id for one call to the tab that asked.
 *
 * @throws {never} `crypto.randomUUID` needs only a secure context, which the app and its engine worker always run in.
 */
export const randomId = (): string => crypto.randomUUID()
