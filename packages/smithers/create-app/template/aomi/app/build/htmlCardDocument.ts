/**
 * The `srcDoc` for a `ui/html` card: the model's fragment behind a CSP that
 * blocks every subresource. `sandbox=""` on the frame already stops scripts,
 * forms, and navigation, but a srcdoc document inherits no policy, so without
 * this an `<img src>` in the fragment could still send data to any host.
 */
export const htmlCardDocument = (html: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">${html}`
