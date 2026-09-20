/**
 * One real module run, trimmed to the records this defect turns on.
 *
 * Recorded by the production `repository-jobs/issues` e2e on 2026-09-20 against
 * the host that emits step facts, then trimmed to nine events and anonymised:
 * the binding, two steps worth of `control.agent.*` step facts, the root
 * `agent/run` run-decision that carries the job's committed document, and the
 * run's completion. Repository names and host identifiers are placeholders; no
 * token or credential was recorded in these fields.
 *
 * The two `control.agent.resolved` facts are step scoped: each one carries the
 * `step` object of the `repository/research` invocation that produced it, and
 * neither is the run's answer. The run's answer is the run-decision's
 * `exit.value`.
 */
import type { ControlSchema } from "@smthrs/control"

/** The job document the root committed, as a reader should read it back. */
export const moduleRunOutput: unknown = {
  "digest": "9cd955f3080248dc733f6f898af6d4cf2ee853b9412d86d60b119b1b771e4449",
  "eventKey": "event-key-1",
  "job": "issues",
  "publicActions": [],
  "repo": "example-org/example-repo",
  "results": [
    {
      "evidence": [
        "source:README.md@d69dda4be66e5d12a5d4ab666fef54736aa3abea861a46b293fae1a9e13a7f9f"
      ],
      "executionId": "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9",
      "output": {
        "citations": [
          "README.md"
        ],
        "classification": "question",
        "duplicates": [],
        "question": "",
        "reproduction": null,
        "summary": "# example-repo"
      },
      "status": "completed",
      "stepId": "research",
      "summary": "# example-repo"
    },
    {
      "evidence": [
        "source:README.md@d69dda4be66e5d12a5d4ab666fef54736aa3abea861a46b293fae1a9e13a7f9f"
      ],
      "executionId": "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5",
      "output": {
        "citations": [
          "README.md"
        ],
        "classification": "question",
        "duplicates": [],
        "question": "",
        "reproduction": null,
        "summary": "The exact first line of README.md is \"# example-repo\"."
      },
      "status": "completed",
      "stepId": "followup",
      "summary": "The exact first line of README.md is \"# example-repo\"."
    }
  ],
  "revision": 1,
  "sourceRevision": "255d8a954b37fc38184d8f38425ed66ccfc61fdf",
  "status": "completed"
}

/** The last step's own resolved text, which must not become the run's answer. */
export const lastStepResolvedText =
  "{\"summary\":\"The exact first line of README.md is \\\"# example-repo\\\".\",\"question\":\"\",\"citations\":[\"README.md\"],\"reproduction\":null}"

/** The excerpt, in journal order. */
export const moduleRunJournal: ReadonlyArray<ControlSchema.ControlEvent> = [
  {
    "sequence": 3,
    "kind": "control.engine.bound",
    "runId": "run-1",
    "occurredAt": 1789905046634,
    "payload": {
      "controlRunId": "run-1",
      "executionId": "run-1",
      "version": 1
    }
  },
  {
    "sequence": 70,
    "kind": "control.engine.event",
    "runId": "run-1",
    "occurredAt": 1789905048358,
    "payload": {
      "emittedAtMs": 1789905048182,
      "eventId":
        "flows:event:64:67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb983:step-fact-v1:b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1:0:1120943835655872",
      "eventType": "flows.harness.step-fact.v1",
      "executionId": "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9",
      "generation": 0,
      "meta": null,
      "payload": {
        "at": 1789905048181,
        "cell": "",
        "eventType": "control.agent.turn-opened",
        "frame": 0,
        "generation": 0,
        "ordinal": 0,
        "payload": {
          "contextDigest": "ce2087dce1cb7e4368f871a4e1c1a926b170cec593a78a1b24cc2a07b7b4ae3c",
          "seat": "repository/research"
        },
        "sourceSequence": 120943835655872,
        "step": {
          "action": "repository/research",
          "ask": 0,
          "attempt": 1,
          "executionId": "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9",
          "retry": 1,
          "scope":
            "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9/repository/research@b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1#0",
          "stepId": "b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f"
        },
        "version": 1
      },
      "sequence": 23,
      "sourceId": "step-fact-v1:b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1:0:1",
      "sourceSequence": 120943835655872,
      "version": 1
    }
  },
  {
    "sequence": 110,
    "kind": "control.engine.event",
    "runId": "run-1",
    "occurredAt": 1789905048937,
    "payload": {
      "emittedAtMs": 1789905048928,
      "eventId":
        "flows:event:64:67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb983:step-fact-v1:b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1:0:159670434778523",
      "eventType": "flows.harness.step-fact.v1",
      "executionId": "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9",
      "generation": 0,
      "meta": null,
      "payload": {
        "at": 1789905048926,
        "cell": "",
        "eventType": "control.agent.model-settled",
        "frame": 0,
        "generation": 0,
        "ordinal": 1,
        "payload": {
          "durationMillis": 701,
          "text":
            "```cell\nctx.done(JSON.stringify({\n  summary: \"# example-repo\",\n  question: \"\",\n  citations: [\"README.md\"],\n  reproduction: null\n}))\n```",
          "usage": {
            "inputTokens": 4289,
            "outputTokens": 207,
            "totalTokens": 4496
          }
        },
        "sourceSequence": 59670434778523,
        "step": {
          "action": "repository/research",
          "ask": 0,
          "attempt": 1,
          "executionId": "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9",
          "retry": 1,
          "scope":
            "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9/repository/research@b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1#0",
          "stepId": "b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f"
        },
        "version": 1
      },
      "sequence": 30,
      "sourceId": "step-fact-v1:b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1:0:1",
      "sourceSequence": 59670434778523,
      "version": 1
    }
  },
  {
    "sequence": 217,
    "kind": "control.engine.event",
    "runId": "run-1",
    "occurredAt": 1789905050033,
    "payload": {
      "emittedAtMs": 1789905049877,
      "eventId":
        "flows:event:64:67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb983:step-fact-v1:b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1:0:1225504187160339",
      "eventType": "flows.harness.step-fact.v1",
      "executionId": "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9",
      "generation": 0,
      "meta": null,
      "payload": {
        "at": 1789905049876,
        "cell": "1cd90c12b8324905c21ed3479c56c960fd83f8457acdccdb0939cae37d4f28cc",
        "eventType": "control.agent.resolved",
        "frame": 0,
        "generation": 0,
        "ordinal": 10,
        "payload": {
          "text":
            "{\"summary\":\"# example-repo\",\"question\":\"\",\"citations\":[\"README.md\"],\"reproduction\":null}"
        },
        "sourceSequence": 225504187160339,
        "step": {
          "action": "repository/research",
          "ask": 0,
          "attempt": 1,
          "executionId": "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9",
          "retry": 1,
          "scope":
            "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9/repository/research@b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1#0",
          "stepId": "b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f"
        },
        "version": 1
      },
      "sequence": 96,
      "sourceId": "step-fact-v1:b51683b0159b8e9218cc2734eb8bfd6a90e7b72a3adb7be3321265289eb1695f:1:0:1",
      "sourceSequence": 225504187160339,
      "version": 1
    }
  },
  {
    "sequence": 250,
    "kind": "control.engine.event",
    "runId": "run-1",
    "occurredAt": 1789905050480,
    "payload": {
      "emittedAtMs": 1789905050349,
      "eventId":
        "flows:event:64:3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a583:step-fact-v1:271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1:0:1211784051154038",
      "eventType": "flows.harness.step-fact.v1",
      "executionId": "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5",
      "generation": 0,
      "meta": null,
      "payload": {
        "at": 1789905050348,
        "cell": "",
        "eventType": "control.agent.turn-opened",
        "frame": 0,
        "generation": 0,
        "ordinal": 0,
        "payload": {
          "contextDigest": "d52071fdd661b6905b32bc58c9f40fcd1941abe018a257d936774faa3cdbd4c9",
          "seat": "repository/research"
        },
        "sourceSequence": 211784051154038,
        "step": {
          "action": "repository/research",
          "ask": 0,
          "attempt": 1,
          "executionId": "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5",
          "retry": 1,
          "scope":
            "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5/repository/research@271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1#0",
          "stepId": "271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830"
        },
        "version": 1
      },
      "sequence": 23,
      "sourceId": "step-fact-v1:271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1:0:1",
      "sourceSequence": 211784051154038,
      "version": 1
    }
  },
  {
    "sequence": 296,
    "kind": "control.engine.event",
    "runId": "run-1",
    "occurredAt": 1789905050852,
    "payload": {
      "emittedAtMs": 1789905050784,
      "eventId":
        "flows:event:64:3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a583:step-fact-v1:271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1:0:1108715914551490",
      "eventType": "flows.harness.step-fact.v1",
      "executionId": "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5",
      "generation": 0,
      "meta": null,
      "payload": {
        "at": 1789905050782,
        "cell": "",
        "eventType": "control.agent.model-settled",
        "frame": 0,
        "generation": 0,
        "ordinal": 1,
        "payload": {
          "durationMillis": 406,
          "text":
            "```cell\nconst output = {\n  summary: \"The exact first line of README.md is \\\"# example-repo\\\".\",\n  question: \"\",\n  citations: [\"README.md\"],\n  reproduction: null\n};\nctx.done(JSON.stringify(output));\n```",
          "usage": {
            "inputTokens": 4291,
            "outputTokens": 295,
            "totalTokens": 4586
          }
        },
        "sourceSequence": 108715914551490,
        "step": {
          "action": "repository/research",
          "ask": 0,
          "attempt": 1,
          "executionId": "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5",
          "retry": 1,
          "scope":
            "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5/repository/research@271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1#0",
          "stepId": "271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830"
        },
        "version": 1
      },
      "sequence": 30,
      "sourceId": "step-fact-v1:271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1:0:1",
      "sourceSequence": 108715914551490,
      "version": 1
    }
  },
  {
    "sequence": 418,
    "kind": "control.engine.event",
    "runId": "run-1",
    "occurredAt": 1789905051958,
    "payload": {
      "emittedAtMs": 1789905051773,
      "eventId":
        "flows:event:64:3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a583:step-fact-v1:271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1:0:1135916594893787",
      "eventType": "flows.harness.step-fact.v1",
      "executionId": "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5",
      "generation": 0,
      "meta": null,
      "payload": {
        "at": 1789905051772,
        "cell": "aa57b4c41dec2396f722dd164022b5306c1be5248f6fb9a11a0727fd8627d357",
        "eventType": "control.agent.resolved",
        "frame": 0,
        "generation": 0,
        "ordinal": 10,
        "payload": {
          "text":
            "{\"summary\":\"The exact first line of README.md is \\\"# example-repo\\\".\",\"question\":\"\",\"citations\":[\"README.md\"],\"reproduction\":null}"
        },
        "sourceSequence": 135916594893787,
        "step": {
          "action": "repository/research",
          "ask": 0,
          "attempt": 1,
          "executionId": "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5",
          "retry": 1,
          "scope":
            "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5/repository/research@271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1#0",
          "stepId": "271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830"
        },
        "version": 1
      },
      "sequence": 96,
      "sourceId": "step-fact-v1:271160fda3e52f708852c0481e60365bb4ff084b16522c7b928d3e4128e75830:1:0:1",
      "sourceSequence": 135916594893787,
      "version": 1
    }
  },
  {
    "sequence": 444,
    "kind": "control.engine.event",
    "runId": "run-1",
    "occurredAt": 1789905052173,
    "payload": {
      "emittedAtMs": 1789905052166,
      "eventId": "flows:event:5:run-147:host-1-engine3",
      "eventType": "flows.engine.run-decision",
      "executionId": "run-1",
      "generation": 0,
      "meta": {
        "lineageId": "smithers-journal-lineage/v1:[\"run-1\"]"
      },
      "payload": {
        "decision": "transitioned",
        "executionFact": {
          "baseline": "legacy",
          "observation": {
            "cancelRequestedAtMs": null,
            "createdAtMs": 1789905045634,
            "executionId": "run-1",
            "finishedAtMs": 1789905052164,
            "flowName": "agent/run",
            "lineageId": "run-1",
            "parentPolicy": "cancel",
            "parentRunId": null,
            "roundOrdinal": 0,
            "startedAtMs": 1789905045661,
            "status": "completed",
            "treeVersion": 1,
            "waiting": null
          },
          "version": 1
        },
        "owner": {
          "hostId": "host-1",
          "nonce": "nonce-1",
          "pid": 1449
        },
        "state": {
          "flowName": "agent/run",
          "payload": {
            "planId": "plan-1",
            "runId": "run-1"
          },
          "result": {
            "_tag": "Complete",
            "exit": {
              "_tag": "Success",
              "value": {
                "digest": "9cd955f3080248dc733f6f898af6d4cf2ee853b9412d86d60b119b1b771e4449",
                "eventKey": "event-key-1",
                "job": "issues",
                "publicActions": [],
                "repo": "example-org/example-repo",
                "results": [
                  {
                    "evidence": [
                      "source:README.md@d69dda4be66e5d12a5d4ab666fef54736aa3abea861a46b293fae1a9e13a7f9f"
                    ],
                    "executionId": "67d5a0682f2387bac95185de9f46671732e41d22489975b381ffad255f9c2eb9",
                    "output": {
                      "citations": [
                        "README.md"
                      ],
                      "classification": "question",
                      "duplicates": [],
                      "question": "",
                      "reproduction": null,
                      "summary": "# example-repo"
                    },
                    "status": "completed",
                    "stepId": "research",
                    "summary": "# example-repo"
                  },
                  {
                    "evidence": [
                      "source:README.md@d69dda4be66e5d12a5d4ab666fef54736aa3abea861a46b293fae1a9e13a7f9f"
                    ],
                    "executionId": "3a461ea86a35f6250cd6acfe3962febfaa35b4fc47d41d45797281d1324ec1a5",
                    "output": {
                      "citations": [
                        "README.md"
                      ],
                      "classification": "question",
                      "duplicates": [],
                      "question": "",
                      "reproduction": null,
                      "summary": "The exact first line of README.md is \"# example-repo\"."
                    },
                    "status": "completed",
                    "stepId": "followup",
                    "summary": "The exact first line of README.md is \"# example-repo\"."
                  }
                ],
                "revision": 1,
                "sourceRevision": "255d8a954b37fc38184d8f38425ed66ccfc61fdf",
                "status": "completed"
              }
            }
          },
          "version": 1
        },
        "status": "completed"
      },
      "sequence": 7,
      "sourceId": "host-1-engine",
      "sourceSequence": 3,
      "version": 1
    }
  },
  {
    "sequence": 448,
    "kind": "control.run.completed",
    "runId": "run-1",
    "occurredAt": 1789905052211,
    "payload": {
      "baseline": "legacy",
      "factVersion": 1,
      "run": {
        "createdAt": 1789905045574,
        "flowId": "repository-jobs/issues",
        "planDigest": "200c449b143a427681b1242e72df05a7a7a81ca7e080caf5fa9f549ca1d3ca20",
        "planId": "plan-1",
        "runId": "run-1",
        "status": "completed",
        "updatedAt": 1789905052210
      },
      "runId": "run-1",
      "status": "completed"
    }
  }
] as ReadonlyArray<ControlSchema.ControlEvent>
