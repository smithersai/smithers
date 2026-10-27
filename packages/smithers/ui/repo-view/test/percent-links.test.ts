import { expect, test } from "bun:test";
import { resolveLink } from "../src/paths";

test("document links preserve literal percents while decoding valid escapes", () => {
  for (const href of ["100%.md", "100%25.md", "100%25%20done%.md", "%E2%9C%93%.md", "%zz.md", "%2.md"]) {
    const name = ({ "100%25.md": "100%.md", "100%25%20done%.md": "100% done%.md", "%E2%9C%93%.md": "✓%.md" } as Record<string, string>)[href] ?? href;
    expect(resolveLink("docs/a.md", href, [`docs/${name}`])).toEqual({ kind: "blob", path: `docs/${name}` });
  }
});
