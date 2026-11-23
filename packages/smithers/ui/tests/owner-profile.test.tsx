/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  contributionMonthLabels,
  OwnerProfile,
  OwnerProfileSkeleton,
  SMITHERS_UI_STYLE_ATTR,
} from "../src/index";
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

describe("OwnerProfile", () => {
  test("renders a GitHub-style user profile overview with README, pinned repos, contributions and orgs", async () => {
    await render(
      <OwnerProfile
        kind="User"
        login="roninjin10"
        name="Will Cory"
        avatarUrl="https://avatars.githubusercontent.com/u/35039927"
        bio="Building Smithers and VibeLang."
        company="@smithersai"
        location="San Francisco"
        website="https://smithers.sh/"
        twitter="@FUCORY"
        followers={1240}
        following={48}
        publicRepos={84}
        createdAt={Date.UTC(2018, 0, 15)}
        githubUrl="https://github.com/roninjin10"
        organizations={[{ login: "smithersai", name: "Smithers", avatarUrl: "https://avatars.githubusercontent.com/u/1", href: "/smithersai" }]}
        readme={{ path: "roninjin10 / README.md", href: "/roninjin10/roninjin10", text: "# Hello\n\nBuilding durable workflows." }}
        pinned
        featured={[
          {
            owner: "roninjin10",
            name: "smithers",
            href: "/roninjin10/smithers",
            description: "Durable coding agent control plane",
            language: "TypeScript",
            stars: 2450,
            forks: 120,
            cloned: true,
          },
        ]}
        contributions={{
          total: 1420,
          commits: 1100,
          pullRequests: 210,
          issues: 60,
          reviews: 50,
          weeks: [
            [{ date: "2026-01-04", count: 0, level: 0 }, { date: "2026-01-05", count: 5, level: 2 }],
            [{ date: "2026-01-11", count: 12, level: 4 }],
          ],
        }}
        tab="overview"
        overviewHref="/roninjin10"
        repositoriesHref="/roninjin10?tab=repositories"
      />,
    );

    expect(q("h1.sui-profile-name")!.textContent).toBe("Will Cory");
    expect(q(".sui-profile-login")!.textContent).toBe("roninjin10");
    expect(q(".sui-profile-bio")!.textContent).toBe("Building Smithers and VibeLang.");
    expect(q(".sui-profile-follows")!.textContent).toContain("1.2k followers");
    expect(q(".sui-profile-follows")!.textContent).toContain("48 following");
    expect(q(".sui-profile-details")!.textContent).toContain("@smithersai");
    expect(q(".sui-profile-details")!.textContent).toContain("San Francisco");
    expect(q(".sui-profile-details")!.textContent).toContain("smithers.sh");
    expect(q(".sui-profile-details")!.textContent).toContain("@FUCORY");
    expect(q(".sui-profile-details")!.textContent).toContain("Joined Jan 2018");
    expect(q(".sui-profile-org-link")!.getAttribute("href")).toBe("/smithersai");
    expect(q(".sui-profile-readme-body")!.textContent).toContain("Building durable workflows.");
    expect(q(".sui-profile-block-title")!.textContent).toBe("Pinned");
    expect(q(".sui-profile-repo-name")!.getAttribute("href")).toBe("/roninjin10/smithers");
    expect(q(".sui-profile-pinned")!.textContent).toContain("Cloned");
    expect(q('[aria-label="Contributions"]')!.textContent).toContain("1,420 contributions in the last year");
    expect(all(".sui-profile-contrib-cell")).toHaveLength(3 + 5);
  });

  test("renders the repositories tab with search, filter, sort controls and safe URL filtering", async () => {
    const events: Array<string> = [];
    await render(
      <OwnerProfile
        kind="Organization"
        login="smithersai"
        website="javascript:alert(1)"
        githubUrl="https://github.com/smithersai"
        tab="repositories"
        overviewHref="/smithersai"
        repositoriesHref="/smithersai?tab=repositories"
        search="vibe"
        sort="stars"
        filter="sources"
        hasClonedRepositories
        onSearchChange={(value) => events.push(`search:${value}`)}
        onSortChange={(value) => events.push(`sort:${value}`)}
        onFilterChange={(value) => events.push(`filter:${value}`)}
        repositories={[
          {
            owner: "smithersai",
            name: "vibelang",
            href: "/smithersai/vibelang",
            description: "Effect as a language",
            language: "TypeScript",
            stars: 500,
            forks: 12,
            license: "MIT",
            topics: ["effect", "compiler"],
            pushedAt: Date.now() - 3_600_000,
          },
        ]}
        totalRepositories={12}
      />,
    );

    expect(q(".sui-profile-avatar-wrap")!.getAttribute("data-kind")).toBe("Organization");
    expect(q(".sui-profile-detail-link")).toBeNull();
    expect(q(".sui-profile-repo-name")!.textContent).toBe("vibelang");
    expect(all(".sui-profile-topic").map((el) => el.textContent)).toEqual(["effect", "compiler"]);
    const buttons = all(".sui-profile-filters button");
    await act(async () => {
      buttons.find((b) => b.textContent === "Cloned")!.click();
      buttons.find((b) => b.textContent === "Name")!.click();
    });
    expect(events).toEqual(["filter:cloned", "sort:name"]);
  });

  test("renders skeleton and computes non-overlapping contribution month labels", async () => {
    await render(<OwnerProfileSkeleton />);
    expect(q('[data-slot="owner-profile"]')!.getAttribute("aria-busy")).toBe("true");
    const labels = contributionMonthLabels([
      [{ date: "2026-01-25", count: 1, level: 1 }],
      [{ date: "2026-02-01", count: 2, level: 2 }],
      [{ date: "2026-02-08", count: 0, level: 0 }],
      [{ date: "2026-02-15", count: 0, level: 0 }],
      [{ date: "2026-03-01", count: 3, level: 3 }],
    ]);
    expect(labels).toEqual([
      { column: 0, label: "Jan" },
      { column: 4, label: "Mar" },
    ]);
  });
});
