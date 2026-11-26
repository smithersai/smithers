import { expect, test } from "vitest"
import { wordsOf } from "./AlertDelivery.vibe"

test("a repository alert names the repository and uses the configured app origin", () => {
  expect(wordsOf({
    kind: "Agent run failed",
    repository: "acme/widgets",
    href: "/app/repos/acme/widgets/runs?status=failed",
  }, "https://smithers.test/app/settings")).toEqual({
    subject: "Agent run failed · acme/widgets",
    text: "https://smithers.test/app/repos/acme/widgets/runs?status=failed",
  })
})
