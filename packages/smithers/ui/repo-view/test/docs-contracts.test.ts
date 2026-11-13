// The docs' copyable examples and stated contracts, held to the code they describe.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readDoc = (path: string): string => readFileSync(join(import.meta.dir, "../docs", path), "utf8");
const guide = readDoc("guides/use-the-repository-views.md");
const diffReference = readDoc("api.md").split("## Pierre diff view")[1]!.split("## Markdown editor")[0]!;

describe("documented view contracts", () => {
  test("the development check command names the compiler the package runs", () => {
    const readme = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    expect(readme).toContain(`pnpm check   # ${manifest.scripts.check}`);
  });

  test("the copyable ready tree type includes directories known without their files", () => {
    const tree = readDoc("api.md").split("type RepoViewTree =")[1]!.split("type RepoViewFile =")[0]!;
    expect(tree).toContain('state: "ready"; paths: ReadonlyArray<string>; directories?: ReadonlyArray<string>; truncated?: boolean');
  });

  test("the lazy DiffSurface module supplies React.lazy's default export", () => {
    const examples = [...guide.matchAll(/```tsx\n([\s\S]*?)```/g)].map((match) => match[1]!);
    const loader = examples.find((example) => example.includes('import("./DiffSurface")'))!;
    const component = examples.find((example) => example.includes("function DiffSurface("))!;
    expect(loader).toContain('lazy(() => import("./DiffSurface"))');
    // Scan the copyable module itself, rather than accepting a prose promise.
    expect(new Bun.Transpiler({ loader: "tsx" }).scan(component).exports).toContain("default");
  });

  test("every copyable example imports from the package root", () => {
    const specifiers = [...guide.matchAll(/from "(@smthrs\/[^"]+)"/g)].map((match) => match[1]!);
    expect(specifiers.length).toBeGreaterThan(3);
    expect(specifiers.filter((specifier) => !["@smthrs/repo-view", "@smthrs/ui"].includes(specifier))).toEqual([]);
  });

  test("the file guide describes automatic workers, bounded startup, fallback and teardown", () => {
    const section = guide.split("## Render one file")[1]!.split("## Edit markdown")[0]!.replace(/\s+/g, " ");
    expect(section).toMatch(/`CodeFileView` automatically starts the worker pool for its theme/);
    expect(section).toContain("Bun and browser worker factories");
    const source = readFileSync(join(import.meta.dir, "../src/workerPool.ts"), "utf8");
    const deadline = Number(source.match(/CODE_VIEW_POOL_DEADLINE_MS = ([\d_]+)/)![1]!.replaceAll("_", ""));
    expect(section).toContain(`${deadline / 1000}-second initialization deadline`);
    expect(section).toContain("main thread only when workers are unavailable or the pool fails");
    expect(section).toContain("disposeCodeViewPool");
    expect(section).toContain("after unmounting its code views, while its DOM still exists");
  });

  test("the diff reference describes registered palette selection and its override", () => {
    const prose = diffReference.replace(/\s+/g, " ");
    for (const contract of ["themeRegistry[palette].syntax", "shikiLight", "shikiDark", "`mode`", "`palette`", "document", "custom unregistered themes"]) {
      expect(prose).toContain(contract);
    }
    expect(diffReference).toContain('<PierreDiffView patch={patch} palette="paper" />');
  });
});
