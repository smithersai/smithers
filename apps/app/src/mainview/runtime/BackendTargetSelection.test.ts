import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { selectedBackendTarget, selectedBackendToken, switchBackendTarget } from "./BackendTargetSelection"
import { loadApplicationTarget } from "./ApplicationTargetRuntime"

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
afterEach(() => sessionStorage.clear())

test("web switch validates the external Plue target and clears an old credential", () => {
  switchBackendTarget("https://plue.example.test", "new-token", "https://smithers.sh")
  expect(selectedBackendTarget("https://smithers.sh")?.mode).toBe("web-plue")
  switchBackendTarget("https://smithers.sh", "", "https://smithers.sh")
  expect(selectedBackendToken()).toBeUndefined()
  expect(selectedBackendTarget("https://smithers.sh")?.mode).toBe("web-selfhost")
  expect(() => switchBackendTarget("javascript:alert(1)", "token", "https://smithers.sh")).toThrow()
})

test("a selected Plue document boots through the application target runtime", async () => {
  const origin = "http://127.0.0.1:14080"
  sessionStorage.setItem("smithers.backend-target", JSON.stringify({
    apiVersion: 1, mode: "web-plue", apiOrigin: "", auth: { kind: "bearer" },
    cors: "same-origin", developerExternal: false
  }))
  await expect(loadApplicationTarget({
    document,
    pageOrigin: origin,
    native: async () => selectedBackendTarget(origin)
  })).resolves.toMatchObject({ mode: "web-plue", shell: "web", ownership: "plue" })
})
