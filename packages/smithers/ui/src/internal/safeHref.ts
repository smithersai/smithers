/**
 * Allow only navigable schemes onto a rendered href. Scheme-less relative and
 * anchor links pass through unchanged; a protocol-relative `//host` or
 * `\\host` link, which names another host without a scheme, does not.
 *
 * Browser URL parsing strips ASCII tab/newline/carriage-return anywhere in the
 * input and trims leading C0 controls, so "java\nscript:..." or
 * "\x01javascript:..." would normalize onto javascript: after the scheme check
 * below already decided there was no scheme. Reject every control character
 * instead of depending on that normalization never happening.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function safeHref(raw: string): string | undefined {
  const href = raw.trim();
  if (CONTROL_CHARS.test(href)) return undefined;
  // "//host" and "\\host" (a browser reads "\\" as "//") leave this origin without naming a scheme.
  if (/^[/\\]{2}/.test(href)) return undefined;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    if (proto !== "http" && proto !== "https" && proto !== "mailto") return undefined;
  }
  return href;
}

/** An image source a page may load: what {@link safeHref} allows, less `mailto:`, which names no image. */
export function safeImageSrc(raw: string): string | undefined {
  const src = safeHref(raw);
  return src === undefined || /^mailto:/i.test(src) ? undefined : src;
}
