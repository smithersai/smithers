/** @jsxImportSource react */
// RepoAbout under happy-dom: a repository's about panel as GitHub's sidebar, every part drawn only when the host has
// it, the shared loading bar while it loads, and links that open GitHub's pages in a new tab with no opener.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { formatCount, languageShares, RepoAbout, SMITHERS_UI_STYLE_ATTR } from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

const q = <E extends Element = HTMLElement>(selector: string) => container!.querySelector<E>(selector);
const all = (selector: string) => [...container!.querySelectorAll<HTMLElement>(selector)];
const texts = (selector: string) => all(selector).map((el) => el.textContent);

describe("RepoAbout", () => {
  test("everything GitHub says, in GitHub's order, with its links", async () => {
    await render(
      <RepoAbout
        description="This repo is for demonstration purposes only."
        homepage="https://example.com/docs/"
        topics={["demo", "forking"]}
        stars={14126}
        watchers={908}
        forks={160292}
        license="MIT"
        release={{ tag: "v1.0.0", name: "First", publishedAt: Date.now() - 86_400_000, href: "https://github.com/o/r/releases/tag/v1.0.0" }}
        releases={2}
        contributors={[{ login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/1", href: "https://github.com/octocat" }]}
        contributorCount={1200}
        languages={[{ name: "HTML", bytes: 355 }, { name: "CSS", bytes: 256 }]}
        footer={<p data-testid="note">note</p>}
      />,
    );
    const panel = q('[data-slot="repo-about"]')!;
    expect(panel.getAttribute("aria-label")).toBe("About");
    expect(texts(".sui-repo-about-heading")).toEqual(["About", "Releases2", "Contributors1.2k", "Languages"]);
    expect(q(".sui-repo-about-description")!.textContent).toBe("This repo is for demonstration purposes only.");
    const homepage = q<HTMLAnchorElement>(".sui-repo-about-homepage")!;
    expect([homepage.textContent, homepage.getAttribute("href"), homepage.target, homepage.rel]).toEqual([
      "example.com/docs",
      "https://example.com/docs/",
      "_blank",
      "noopener noreferrer",
    ]);
    expect(texts(".sui-repo-about-topic")).toEqual(["demo", "forking"]);
    expect(texts(".sui-repo-about-stats li")).toEqual(["14.1k stars", "908 watching", "160.3k forks", "MIT"]);
    expect(q(".sui-repo-about-release-name")!.getAttribute("href")).toBe("https://github.com/o/r/releases/tag/v1.0.0");
    expect(q(".sui-repo-about-release")!.textContent).toContain("First");
    expect(q(".sui-repo-about-latest")!.textContent).toBe("Latest");
    const avatar = q<HTMLImageElement>(".sui-repo-about-avatar")!;
    expect([avatar.alt, avatar.getAttribute("referrerpolicy"), avatar.closest("a")!.getAttribute("href")]).toEqual([
      "octocat",
      "no-referrer",
      "https://github.com/octocat",
    ]);
    expect(texts(".sui-repo-about-languages li")).toEqual(["HTML58.1%", "CSS41.9%"]);
    expect(all(".sui-repo-about-bar > span").map((el) => el.style.width)).toEqual(["58.1%", "41.9%"]);
    expect(q('[data-testid="note"]')!.parentElement!.className).toBe("sui-repo-about-footer");
    // Idle: the loading bar is mounted, hidden from assistive tech.
    expect(q('[data-slot="loading-bar"]')!.getAttribute("data-state")).toBe("idle");
  });

  test("a part the host doesn't have isn't drawn; an unsafe homepage isn't either; a release without its link", async () => {
    await render(
      <RepoAbout
        homepage="javascript:alert(1)"
        release={{ tag: "v2", name: null }}
        contributors={[{ login: "a", avatarUrl: "https://avatars.githubusercontent.com/u/2" }]}
        loading
      />,
    );
    expect(texts(".sui-repo-about-heading")).toEqual(["About", "Releases", "Contributors1"]);
    expect(q(".sui-repo-about-description")).toBeNull();
    expect(q(".sui-repo-about-homepage")).toBeNull();
    expect(q(".sui-repo-about-topics")).toBeNull();
    expect(q(".sui-repo-about-stats")).toBeNull();
    expect(q("span.sui-repo-about-release-name")!.textContent).toBe("v2");
    expect(q(".sui-repo-about-release time, .sui-repo-about-release .sui-repo-about-muted")).toBeNull();
    expect(q(".sui-repo-about-people a")).toBeNull();
    expect(q(".sui-repo-about-bar")).toBeNull();
    expect(q(".sui-repo-about-footer")).toBeNull();
    const bar = q('[data-slot="loading-bar"]')!;
    expect([bar.getAttribute("data-state"), bar.getAttribute("role"), bar.getAttribute("aria-hidden")]).toEqual([
      "loading",
      null,
      "true",
    ]);
  });

  test("an avatar loads only from http(s) or this origin; an unsafe one leaves the image without a source", async () => {
    const avatars = ["https://avatars.example/u/1", "/me.png", "javascript:alert(1)", "data:image/svg+xml,x", "//evil.example/p.gif", "mailto:a@b.c"];
    await render(<RepoAbout contributors={avatars.map((avatarUrl, index) => ({ login: `p${index}`, avatarUrl }))} />);
    expect(all(".sui-repo-about-avatar").map((img) => img.getAttribute("src"))).toEqual(["https://avatars.example/u/1", "/me.png", null, null, null, null]);
    expect(all(".sui-repo-about-avatar").map((img) => img.getAttribute("alt"))).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
  });

  test("a language named like an Object member is a language without a color", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect([name, languageShares([{ name, bytes: 1 }])[0]!.color]).toEqual([name, "var(--text-faint, #6c655a)"]);
    }
  });

  test("counts and shares as GitHub writes them; a language under 0.1% folds into Other", () => {
    expect([formatCount(0), formatCount(908), formatCount(14126), formatCount(1_200_000)]).toEqual(["0", "908", "14.1k", "1.2m"]);
    expect(languageShares([])).toEqual([]);
    expect(languageShares([{ name: "Empty", bytes: 0 }])).toEqual([]);
    expect(languageShares([{ name: "TypeScript", bytes: 9_990 }, { name: "Nix", bytes: 5 }, { name: "Awk", bytes: 5 }, { name: "Zero", bytes: 0 }]))
      .toEqual([
        { name: "TypeScript", percent: 99.9, color: "#3178c6" },
        { name: "Other", percent: 0.1, color: "var(--text-faint, #6c655a)" },
      ]);
    expect(languageShares([{ name: "Brainfuck", bytes: 1 }])[0]!.color).toBe("var(--text-faint, #6c655a)");
  });
});
