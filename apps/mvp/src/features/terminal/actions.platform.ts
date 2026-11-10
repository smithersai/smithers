/**
 * A fresh random terminal id from the browser's Web Crypto.
 *
 * @throws {never} The app runs only in secure contexts (HTTPS, localhost, Node), where `crypto.randomUUID` exists.
 */
export const randomUUID = (): string => crypto.randomUUID()
