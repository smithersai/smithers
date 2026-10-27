import assert from "node:assert/strict"
import test from "node:test"
import { projection } from "../sync-app-docs.mjs"

test("sd4-missing-9: supported generic model and sandbox configuration is published", () => {
  const text = projection().get("apps/site/public/docs/operator.md")
  assert.ok(text, "operator reference is published")
  for (const name of ["MODEL_DAILY_TOKEN_BUDGET", "MODEL_MAX_OUTPUT_TOKENS", "MODEL_MAX_MESSAGES", "MODEL_MAX_REQUEST_BYTES", "SANDBOX_IDLE_SECONDS", "SANDBOX_COMMAND_MAX_SECONDS", "SANDBOX_INSTANCE", "ELECTRIC_GATEWAY"]) assert.ok(text.includes(name), name)
  assert.match(text, /service binding/)
  assert.match(text, /Cloudflare/)
})
