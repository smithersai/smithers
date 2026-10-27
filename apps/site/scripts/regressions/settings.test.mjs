import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { projection } from "../sync-app-docs.mjs"

test("sd4-missing-1: settings guide is published with member and admin controls", () => {
  const text = projection().get("apps/site/public/docs/settings.md")
  assert.ok(text, "settings guide is in the publishing TOC")
  for (const control of ["Your model", "Fast", "Implement", "Hard", "Test", "Remove", "Admin", "Sandbox", "alerts"]) assert.ok(text.includes(control), control)
  assert.match(text, /\/app\/settings/)
  const view = readFileSync(new URL("../../../mvp/src/screens/settings/SettingsScreen.tsx", import.meta.url), "utf8")
  for (const component of ["PersonalModelSettings", "AlertSettings", "SandboxLimitsSettings"]) assert.ok(view.includes(component), component)
})
