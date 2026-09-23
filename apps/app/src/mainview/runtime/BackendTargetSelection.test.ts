import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { selectedBackendTarget, selectedBackendToken, switchBackendTarget } from "./BackendTargetSelection"

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
