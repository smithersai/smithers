import { describe, test } from "vitest"
import { type IssueRecord } from "../src/core/conversation.vibe"
import { canLinkIssues, issueAncestorAt, nextIssueNumber } from "../src/core/issueGraphDecision.vibe"
import { accountRoute, routeKind, sameOriginRequest, sessionCookie } from "../src/core/protocolDecision.vibe"
import {
  beginReply,
  beginReplyComposition,
  canComposeReply,
  canSettleReply,
  finishReplyComposition,
  recordReplySettlement,
  recordReplyStart,
  replyLawful
} from "../src/core/replyDecision.vibe"
import { decisionId, decisionLabel, headingTitle, pageId } from "../src/core/wikiBuildDecision.vibe"

const opts = { time: 120, warmupTime: 30 }

const issues: ReadonlyArray<IssueRecord> = Array.from({ length: 64 }, (_, index) => ({
  number: index + 1,
  parent: index === 0 ? 0 : Math.floor((index - 1) / 2) + 1,
  title: `Issue #${index + 1}`,
  status: index % 3 === 0 ? "closed" : "open"
})) as unknown as ReadonlyArray<IssueRecord>

const wikiDoc = "# 0016 — Coverage Measurement\n\nRuling: Measure every .vibe runtime source in Node and workerd.\n"

describe("@smthrs/vibelang-site", () => {
  test("issueGraphDecision ancestor walk + link admission (64 issues)", async ({ bench }) => {
    await bench("issueGraphDecision (64 issues)", () => {
      issueAncestorAt(issues, 64, 5)
      canLinkIssues(issues, 64, 2)
      nextIssueNumber(issues)
    }).run(opts)
  })

  test("replyDecision full state-machine lifecycle", async ({ bench }) => {
    await bench("replyDecision lifecycle", () => {
      let run = beginReply()
      run = recordReplyStart(run, "ans-1")
      if (canComposeReply(run)) run = beginReplyComposition(run)
      run = finishReplyComposition(run)
      if (canSettleReply(run)) run = recordReplySettlement(run)
      replyLawful(run)
    }).run(opts)
  })

  test("protocolDecision routing and origin checks", async ({ bench }) => {
    await bench("protocolDecision (routes + origin)", () => {
      routeKind("GET", "events")
      routeKind("POST", "messages")
      accountRoute("/api/accounts/session")
      sameOriginRequest("https://vibelang.smithers.sh/api/events", "https://vibelang.smithers.sh")
      sessionCookie("https://vibelang.smithers.sh", "https://vibelang.smithers.sh", true, "sid=abc")
    }).run(opts)
  })

  test("wikiBuildDecision heading and ID parsing", async ({ bench }) => {
    await bench("wikiBuildDecision (parse + title)", () => {
      pageId("0016-coverage.md")
      decisionId("0016")
      decisionLabel("0016")
      headingTitle(wikiDoc)
    }).run(opts)
  })
})
