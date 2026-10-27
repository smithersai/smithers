import { expect, test } from "bun:test";
import { markdownCode } from "../src/markdownCode";

test("read-only fences reuse TS, VibeLang and shell colors and preserve source bytes", () => {
  for (const [language, source] of [
    ["ts", 'const x = "safe"\n// comment'],
    ["vibe", 'service Store {\n  get(): string\n}'],
    ["BASH", '# install\npnpm add "vibelang"\necho 12'],
    ["", "--record\nkill -9"],
    ["unknown", "<script>bad()</script>"],
  ]) {
    const pre = markdownCode(language!, source!);
    expect(pre.textContent).toBe(source!);
    expect(pre.querySelector("script")).toBeNull();
    expect(pre.tabIndex).toBe(0);
    expect(pre.getAttribute("aria-label")).toBe(language ? `${language} code` : "Code");
    if (["ts", "vibe", "BASH"].includes(language!)) expect(pre.querySelector(".sui-rh-tok-keyword")).not.toBeNull();
  }
});
