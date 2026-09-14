// Conditional truthiness of symbolic values must be rejected by the documented lint rule.
import * as Node from "../../../src/Node.ts"
Node.bindPlanned(Node.succeed(false), (value) => value ? Node.succeed("yes") : Node.succeed("no"))
Node.bindPlanned(Node.succeed(false), (value) => {
  if (value) return Node.succeed("yes")
  return Node.succeed("no")
})
Node.bindPlanned(Node.succeed(false), (value) => Node.succeed(Boolean(value)))
Node.branch(Node.succeed(false), {
  if: (value) => value,
  then: () => Node.succeed("yes"),
  else: () => Node.succeed("no")
})
Node.map(Node.succeed(false), (value) => value ? "yes" : "no")
