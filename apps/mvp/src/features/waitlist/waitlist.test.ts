import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import { submitWaitlist, waitlistErrorMessage, WaitlistJoinFailed } from "./api.ts"
import { renderWaitlistPrompt } from "./waitlist-render.tsx"

const clientOf = (respond: (request: { readonly url: string }) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)))),
  )

describe("waitlist client api", () => {
  test("submits a valid repository URL and decodes queue position", async () => {
    const result = await Effect.runPromise(
      submitWaitlist({
        origin: "https://smithers.sh",
        repoUrl: "https://github.com/evmts/voltaire",
        workflowNote: ".smithers/workflows/ci.vibe",
      }).pipe(
        Effect.provide(
          clientOf(() =>
            new Response(
              JSON.stringify({ status: "submitted", repoUrl: "https://github.com/evmts/voltaire", position: 7 }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
    )
    expect(result).toEqual({
      status: "submitted",
      repoUrl: "https://github.com/evmts/voltaire",
      position: 7,
    })
  })

  test("maps server refusal codes to concise user messages", async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        submitWaitlist({ origin: "https://smithers.sh", repoUrl: "http://bad" }).pipe(
          Effect.provide(
            clientOf(() =>
              new Response(JSON.stringify({ error: "invalid_repo_url" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
      ),
    )
    expect(err).toBeInstanceOf(WaitlistJoinFailed)
    expect(err.code).toBe("invalid_repo_url")
    expect(waitlistErrorMessage(err)).toBe("Enter a valid HTTPS repository URL.")
    expect(waitlistErrorMessage(new WaitlistJoinFailed({ status: 429, code: "rate_limited" }))).toContain("Too many requests")
    expect(waitlistErrorMessage(new WaitlistJoinFailed({ status: 403, code: "person_only" }))).toContain("Sign in directly")
  })
})

describe("WaitlistPrompt", () => {
  test("renders idle, submitted receipt, and error states", () => {
    const idle = renderWaitlistPrompt({
      repoUrl: "https://github.com/evmts/voltaire",
      workflowNote: ".smithers/workflows/ci.vibe",
      status: "idle",
      onRepoUrlChange: () => {},
      onWorkflowNoteChange: () => {},
      onSubmit: () => {},
    })
    expect(idle).toContain("Host your repository on smithers.sh")
    expect(idle).toContain("Request maintainer access")

    const submitted = renderWaitlistPrompt({
      repoUrl: "https://github.com/evmts/voltaire",
      status: "submitted",
      position: 7,
      onRepoUrlChange: () => {},
      onSubmit: () => {},
    })
    expect(submitted).toContain("Waitlist confirmed")
    expect(submitted).toContain("position 7")

    const failed = renderWaitlistPrompt({
      repoUrl: "https://github.com/evmts/voltaire",
      status: "error",
      errorMessage: "Enter a valid HTTPS repository URL.",
      onRepoUrlChange: () => {},
      onSubmit: () => {},
    })
    expect(failed).toContain("Enter a valid HTTPS repository URL.")
  })
})
