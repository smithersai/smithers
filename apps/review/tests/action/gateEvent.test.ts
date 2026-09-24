import { describe, expect, test } from "bun:test";
import { gateEvent } from "../../action/src/gateEvent.ts";

describe("gateEvent", () => {
  describe("pull_request", () => {
    test.each([null, {}, { full_name: "" }])("skips missing head repository %j", (repo) => {
      expect(gateEvent({ eventName: "pull_request", payload: {
        action: "opened", pull_request: { number: 1, head: { repo }, base: { repo: { full_name: "octo/widgets" } } },
      } }).run).toBe(false);
    });

    test("runs non-draft same-repo PR and surfaces the head sha", () => {
      const decision = gateEvent({
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          pull_request: {
            number: 42,
            draft: false,
            head: { sha: "abc123", repo: { full_name: "octo/widgets" } },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(decision.run).toBe(true);
      if (decision.run) {
        expect(decision.eventName).toBe("pull_request");
        expect(decision.prNumber).toBe(42);
        expect(decision.headSha).toBe("abc123");
      }
    });

    test("skips drafts", () => {
      const d = gateEvent({
        eventName: "pull_request",
        payload: {
          action: "opened",
          pull_request: {
            number: 1,
            draft: true,
            head: { repo: { full_name: "octo/widgets" } },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(d.run).toBe(false);
      if (!d.run) expect(d.reason).toMatch(/draft/i);
    });

    test("skips fork PRs", () => {
      const d = gateEvent({
        eventName: "pull_request",
        payload: {
          action: "opened",
          pull_request: {
            number: 1,
            draft: false,
            head: { repo: { full_name: "drive-by/fork" }, sha: "x" },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(d.run).toBe(false);
      if (!d.run) expect(d.reason).toMatch(/fork/i);
    });

    test("skips actions that do not change the diff", () => {
      const d = gateEvent({
        eventName: "pull_request",
        payload: {
          action: "labeled",
          pull_request: {
            number: 3,
            draft: false,
            head: { sha: "abc", repo: { full_name: "octo/widgets" } },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(d.run).toBe(false);
      if (!d.run) expect(d.reason).toMatch(/does not change the diff/);
    });

    test("runs ready_for_review on a non-draft same-repo PR", () => {
      const d = gateEvent({
        eventName: "pull_request",
        payload: {
          action: "ready_for_review",
          pull_request: {
            number: 5,
            draft: false,
            head: { sha: "def456", repo: { full_name: "octo/widgets" } },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(d.run).toBe(true);
      if (d.run) {
        expect(d.prNumber).toBe(5);
        expect(d.headSha).toBe("def456");
      }
    });

    test("rejects payload missing pull_request", () => {
      const d = gateEvent({ eventName: "pull_request", payload: { action: "opened" } });
      expect(d.run).toBe(false);
    });
  });

  describe("issue_comment", () => {
    const issuePr = (number: number) => ({
      number,
      pull_request: { url: "https://api.github.com/repos/octo/widgets/pulls/7" },
    });

    test("runs for an OWNER comment beginning with @smithers review", () => {
      const d = gateEvent({
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: issuePr(7),
          comment: { body: "@smithers review please", author_association: "OWNER" },
        },
      });
      expect(d.run).toBe(true);
      if (d.run) {
        expect(d.eventName).toBe("issue_comment");
        expect(d.prNumber).toBe(7);
      }
    });

    test("runs for COLLABORATOR and MEMBER", () => {
      for (const association of ["COLLABORATOR", "MEMBER"]) {
        const d = gateEvent({
          eventName: "issue_comment",
          payload: {
            action: "created",
            issue: issuePr(9),
            comment: { body: "@smithers review", author_association: association },
          },
        });
        expect(d.run).toBe(true);
      }
    });

    test("magic phrase comparison is case-insensitive", () => {
      const d = gateEvent({
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: issuePr(11),
          comment: { body: "@Smithers Review", author_association: "OWNER" },
        },
      });
      expect(d.run).toBe(true);
    });

    test("skips edited and deleted comment actions (no re-trigger on unchanged diff)", () => {
      for (const action of ["edited", "deleted"]) {
        const d = gateEvent({
          eventName: "issue_comment",
          payload: {
            action,
            issue: issuePr(7),
            comment: { body: "@smithers review", author_association: "OWNER" },
          },
        });
        expect(d.run).toBe(false);
        if (!d.run) expect(d.reason).toMatch(/is not "created"/);
      }
    });

    test("skips issue_comment payloads with no action", () => {
      const d = gateEvent({
        eventName: "issue_comment",
        payload: {
          issue: issuePr(7),
          comment: { body: "@smithers review", author_association: "OWNER" },
        },
      });
      expect(d.run).toBe(false);
    });

    test("skips comments on issues that are not PRs", () => {
      const d = gateEvent({
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: { number: 7 },
          comment: { body: "@smithers review", author_association: "OWNER" },
        },
      });
      expect(d).toEqual({ run: false, reason: "comment is not on a pull request" });
    });

    test("skips comments that do not begin with the magic phrase", () => {
      const d = gateEvent({
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: issuePr(7),
          comment: { body: "lgtm", author_association: "OWNER" },
        },
      });
      expect(d).toEqual({ run: false, reason: 'comment does not start with "@smithers review"' });
    });

    test.each(["NONE", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", undefined])(
      "rejects drive-by association %s",
      (association) => {
        const d = gateEvent({
          eventName: "issue_comment",
          payload: {
            action: "created",
            issue: issuePr(7),
            comment: { body: "@smithers review", author_association: association },
          },
        });
        expect(d).toEqual({
          run: false,
          reason: `comment author association "${String(association)}" is not OWNER/MEMBER/COLLABORATOR`,
        });
      },
    );
  });

  test("unsupported events skip", () => {
    const d = gateEvent({ eventName: "push", payload: {} });
    expect(d.run).toBe(false);
  });

  test("null payload skips without throwing", () => {
    const d = gateEvent({ eventName: "pull_request", payload: null });
    expect(d.run).toBe(false);
  });
});
