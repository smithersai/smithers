// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

// Pagefind's page heading and nested section links. The generated UI styles use three classes;
// keep that specificity here so our rule is tested against the display rule it overrides.
test("docs search hides the repeated top title and preserves canonical and section links", () => {
  const style = document.createElement("style")
  style.textContent = `.pagefind-ui__result-nested.generated.generated { display: flex; }\n` +
    readFileSync("../site/src/styles/starlight.css", "utf8")
  const results = document.createElement("div")
  results.id = "starlight__search"
  results.innerHTML = `
    <a href="/docs/quickstart/">Quickstart</a>
    <div class="pagefind-ui__result-nested generated"><a href="/docs/quickstart/#_top">Quickstart</a></div>
    <div class="pagefind-ui__result-nested generated"><a href="/docs/quickstart/#next-steps">Next steps</a></div>
    <a href="/docs/reference/api/scorers/">@smthrs/scorers</a>
    <div class="pagefind-ui__result-nested generated"><a href="/docs/reference/api/scorers/#_top">@smthrs/scorers</a></div>`
  document.head.append(style)
  document.body.append(results)
  try {
    const nested = [...results.querySelectorAll<HTMLElement>(".pagefind-ui__result-nested")]
    expect(nested.map((element) => getComputedStyle(element).display)).toEqual(["none", "flex", "none"])
    for (const anchor of results.querySelectorAll<HTMLElement>(":scope > a")) expect(getComputedStyle(anchor).display).not.toBe("none")
  } finally { style.remove(); results.remove() }
})
