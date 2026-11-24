/**
 * Which URLs a read-only README may carry. A browser trims leading and
 * trailing C0 controls and spaces and drops tab, LF and CR anywhere before it
 * reads a scheme, so the checks below run on that normalized form: "java\nscript:"
 * and "\u0001javascript:" are javascript: links to the browser and here.
 */
const normalize = (value: string): string => value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");

/** A colon before any `/`, `?` or `#` names a scheme; the browser reads one there. */
const schemeOf = (value: string): string | undefined => /^([^/?#]*):/.exec(value)?.[1]?.toLowerCase();

/** A link a click may follow: http(s), mailto, or a path, query or anchor in this document. */
export const navigableLink = (value: string): boolean => {
  const scheme = schemeOf(normalize(value));
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto";
};

/**
 * A URL raw HTML may keep: http(s) or a path on the repository's own host.
 * `//host` and `\\host` (which a browser reads as `//host`) leave it, and an
 * image never loads `mailto:`.
 */
export const safeHtmlUrl = (value: string, attribute: "href" | "src"): boolean => {
  const url = normalize(value);
  if (/^[/\\]{2}/.test(url)) return false;
  const scheme = schemeOf(url);
  return scheme === undefined || scheme === "http" || scheme === "https" || (scheme === "mailto" && attribute === "href");
};
