/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Commit,
  CommitActions,
  CommitAuthor,
  CommitFile,
  CommitFilePath,
  CommitFiles,
  CommitFileStatus,
  CommitHash,
  CommitHeader,
  CommitInfo,
  CommitMessage,
  CommitMetadata,
  CommitTimestamp,
} from "../src/artifacts/Commit";
import { ChangeSummary } from "../src/artifacts/ChangeSummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("Commit", () => {
  test("model mode renders author, hash, message, timestamp, and files", async () => {
    await render(
      <Commit
        commit={{
          hash: "abcdef1234567890",
          message: "feat: add artifacts",
          author: "will",
          timestampMs: 1_750_000_000_000,
          files: [
            { path: "src/a.ts", status: "added", additions: 10, deletions: 0 },
            { path: "src/b.ts", status: "modified", additions: 2, deletions: 3 },
            { path: "src/new.ts", status: "renamed", oldPath: "src/old.ts" },
            { path: "src/gone.ts", status: "deleted" },
            { path: "src/copy.ts", status: "copied" },
          ],
        }}
      />,
    );
    expect(container!.querySelector('[data-slot="commit"]')!.getAttribute("data-vcs")).toBe("git");
    expect(container!.querySelector('[data-slot="commit-author"]')!.textContent).toBe("will");
    expect(container!.querySelector('[data-slot="commit-message"]')!.textContent).toBe("feat: add artifacts");
    expect(container!.querySelector("time")!.getAttribute("dateTime")).toBe(new Date(1_750_000_000_000).toISOString());
    const files = container!.querySelectorAll('[data-slot="commit-file"]');
    expect(files).toHaveLength(5);
    const glyphs = [...container!.querySelectorAll('[data-slot="commit-file-status"] [aria-hidden="true"]')].map(
      (el) => el.textContent,
    );
    expect(glyphs).toEqual(["A", "M", "R", "D", "C"]);
    expect(container!.textContent).toContain("src/old.ts");
    expect(container!.textContent).toContain("+10");
    expect(container!.textContent).toContain("−3");
    // screen-reader status text is present even though the glyph is aria-hidden
    const sr = container!.querySelector('[data-slot="commit-file-status"] .sui-sr-only');
    expect(sr!.textContent).toBe("added");
  });

  test("CommitHash prefers the jj change id and shortens to 7 chars", async () => {
    await render(<CommitHash hash="abcdef1234567890" changeId="klmnopqrstuvwx" />);
    const hash = container!.querySelector('[data-slot="commit-hash"]')!;
    expect(hash.getAttribute("data-vcs")).toBe("jj");
    expect(hash.textContent).toBe("klmnopq");
    expect(hash.getAttribute("title")).toBe("klmnopqrstuvwx");
  });

  test("CommitHash short=false renders the full hash", async () => {
    await render(<CommitHash hash="abcdef1234567890" short={false} />);
    expect(container!.querySelector('[data-slot="commit-hash"]')!.textContent).toBe("abcdef1234567890");
  });

  test("compound mode composes parts", async () => {
    await render(
      <Commit>
        <CommitHeader>
          <CommitAuthor>will</CommitAuthor>
          <CommitInfo>
            <CommitHash hash="abc1234" />
            <CommitTimestamp timestampMs={0} />
          </CommitInfo>
          <CommitActions>
            <button type="button">Revert</button>
          </CommitActions>
        </CommitHeader>
        <CommitMessage>compound</CommitMessage>
        <CommitMetadata>meta</CommitMetadata>
        <CommitFiles>
          <CommitFile file={{ path: "x.ts", status: "added" }} />
        </CommitFiles>
      </Commit>,
    );
    expect(container!.querySelector('[data-slot="commit-actions"]')!.getAttribute("role")).toBe("toolbar");
    expect(container!.querySelector('[data-slot="commit-metadata"]')!.textContent).toBe("meta");
    expect(container!.querySelectorAll('[data-slot="commit-file"]')).toHaveLength(1);
  });

  test("CommitFilePath renders renames as oldPath → path", async () => {
    await render(
      <>
        <CommitFileStatus status="renamed" />
        <CommitFilePath path="new.ts" oldPath="old.ts" />
      </>,
    );
    expect(container!.querySelector('[data-slot="commit-file-path"]')!.textContent).toContain("old.ts");
    expect(container!.querySelector('[data-slot="commit-file-path"]')!.textContent).toContain("new.ts");
  });
});

describe("ChangeSummary", () => {
  test("renders +N −M · K files with a git diff aria-label", async () => {
    await render(<ChangeSummary additions={12} deletions={4} filesChanged={3} />);
    const el = container!.querySelector('[data-slot="change-summary"]')!;
    expect(el.textContent).toContain("+12");
    expect(el.textContent).toContain("−4");
    expect(el.textContent).toContain("3 files");
    expect(el.getAttribute("aria-label")).toBe("12 additions, 4 deletions, 3 files changed in this diff");
  });

  test("vcs=jj switches the accessible terminology to working-copy change", async () => {
    await render(<ChangeSummary additions={1} deletions={1} filesChanged={1} vcs="jj" />);
    const el = container!.querySelector('[data-slot="change-summary"]')!;
    expect(el.getAttribute("aria-label")).toBe("1 additions, 1 deletions, 1 files changed in this working-copy change");
    expect(el.getAttribute("data-vcs")).toBe("jj");
    expect(el.textContent).toContain("1 file");
  });

  test("compact hides the files segment visually", async () => {
    await render(<ChangeSummary additions={2} deletions={1} filesChanged={5} compact />);
    const el = container!.querySelector('[data-slot="change-summary"]')!;
    expect(el.querySelector(".sui-changesum-files")).toBeNull();
    expect(el.getAttribute("aria-label")).toContain("5 files changed");
  });

  test("renders under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<ChangeSummary additions={1} deletions={0} filesChanged={1} />);
    expect(container!.querySelector('[data-slot="change-summary"]')).not.toBeNull();
  });
});
