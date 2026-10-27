/** The browser's language and writing direction, including explicit script overrides. */
export function documentLocale(language: string): { readonly lang: string; readonly dir: "rtl" | "ltr" } {
  try {
    const locale = new Intl.Locale(language)
    const script = locale.maximize().script
    return { lang: locale.toString(), dir: /^(Arab|Hebr|Thaa|Nkoo|Adlm|Rohg|Syrc|Samr|Mand)$/.test(script ?? "") ? "rtl" : "ltr" }
  // expected: an invalid language preference falls back to English.
  } catch {
    return { lang: "en", dir: "ltr" }
  }
}

/** Apply at the browser boundary, before the app paints. */
export function applyDocumentLocale(root: Pick<HTMLElement, "lang" | "dir">, language: string): void {
  const locale = documentLocale(language)
  root.lang = locale.lang
  root.dir = locale.dir
}
