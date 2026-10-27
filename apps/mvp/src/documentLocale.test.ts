import { expect, test } from "vitest"
import { applyDocumentLocale, documentLocale } from "./documentLocale"

test.each(["ar", "he", "fa", "ur", "dv", "ps", "ar-EG", "en-Arab", "ff-Adlm", "syr", "nqo"])('%s uses its writing direction', (language) => {
  expect(documentLocale(language)).toEqual({ lang: new Intl.Locale(language).toString(), dir: "rtl" })
})
test.each(["en", "de", "ja", "ar-Latn", "az", "ku", "qaa"])('%s reads left to right', language => {
  expect(documentLocale(language)).toEqual({ lang: language, dir: "ltr" })
})
test.each(["", "not_a_locale", "x"])('invalid locale %s falls back to English', language => {
  expect(documentLocale(language)).toEqual({ lang: "en", dir: "ltr" })
})
test("the document receives both language and direction, and can change back", () => {
  const root = { lang: "en", dir: "ltr" }
  applyDocumentLocale(root, "ar")
  expect(root).toEqual({ lang: "ar", dir: "rtl" })
  applyDocumentLocale(root, "ja")
  expect(root).toEqual({ lang: "ja", dir: "ltr" })
})
