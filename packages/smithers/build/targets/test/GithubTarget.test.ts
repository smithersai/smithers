import { describe, expect, it } from "vitest"
import * as GithubTarget from "../src/GithubTarget.ts"
import * as Target from "../src/Target.ts"

describe("Github.Workflow build-system attrs", () => {
  it("refuses attributes read through the wrong rule accessor", () => {
    const setup = GithubTarget.Setup({})
    expect(() => GithubTarget.workflowAttrsOf(setup)).toThrow("expected a Github.Workflow target")
  })

  it("reads a Github.Setup target through its own accessor", () => {
    const setup = GithubTarget.Setup({})
    expect(GithubTarget.setupAttrsOf(setup)).toEqual(Target.metadata(setup).attrs)
  })

  it("accepts typed triggers, workflow policy, and raw steps without run targets", () => {
    const workflow = GithubTarget.Workflow({
      name: "coordinate",
      on: {
        pullRequest: { branches: ["main"], types: ["opened", "ready_for_review"] },
        pullRequestTarget: { branches: ["main"], types: ["opened", "synchronize"] },
        issues: { types: ["opened", "labeled"] },
        workflowDispatch: {
          inputs: {
            force_publish: {
              description: "Publish even when unchanged",
              required: true,
              default: false,
              type: "boolean"
            }
          }
        }
      },
      permissions: { contents: "read", "pull-requests": "write", issues: "read" },
      concurrency: { group: "coordinate-${{ github.repository }}", cancelInProgress: false },
      env: { CARGO_TERM_COLOR: "always" },
      environment: "prod",
      condition: "github.event_name != 'pull_request' || github.event.pull_request.state == 'open'",
      jobName: "Coordinate",
      runsOn: "blacksmith-4vcpu-ubuntu-2404",
      steps: [
        {
          uses: "actions/checkout@v4",
          with: { "fetch-depth": "0" }
        },
        {
          name: "Coordinate",
          id: "coordinate",
          if: "github.ref == 'refs/heads/main'",
          run: ["echo first", "echo second"],
          shell: "bash",
          workingDirectory: ".smithers",
          env: { GH_TOKEN: "${{ github.token }}" }
        }
      ]
    })

    const attrs = GithubTarget.workflowAttrsOf(workflow)
    expect(attrs.run).toEqual([])
    expect(attrs.on.workflowDispatch).toEqual({
      inputs: {
        force_publish: {
          description: "Publish even when unchanged",
          required: true,
          default: false,
          type: "boolean"
        }
      }
    })
    expect(attrs.on.pullRequestTarget).toEqual({ branches: ["main"], types: ["opened", "synchronize"] })
    expect(attrs.steps?.[1]).toMatchObject({
      run: ["echo first", "echo second"],
      workingDirectory: ".smithers"
    })
    expect(Target.metadata(workflow).target).toBe("Github.Workflow")
  })
})
