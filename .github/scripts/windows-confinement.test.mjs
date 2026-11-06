import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const workflow = readFileSync(new URL("../workflows/windows-confinement.yml", import.meta.url), "utf8")
const provision = workflow.split("      - name: Provision WSL2\n")[1]?.split("      - name:")[0]

// Conversion is not an idempotent assertion: WSL returns
// WSL_E_VM_MODE_INVALID_STATE when the distro is already at version 2 (#4166).
test("provisioning launches the installed WSL2 distro without converting it again", () => {
  assert.ok(provision, "missing WSL2 provisioning step")
  assert.doesNotMatch(provision, /wsl\s+--set-version\b/)
  assert.match(provision, /wsl --set-default-version 2/)
  assert.match(provision, /wsl --install --distribution Ubuntu-24\.04 --no-launch --web-download/)
  assert.match(provision, /\$kernel = wsl --distribution Ubuntu-24\.04 --user root --exec uname -r\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw 'WSL2 launch failed' \}/)
  assert.match(provision, /Assert-Wsl2Kernel \(\(\$kernel -join "`n"\)\.Trim\(\)\)/)
  assert.match(workflow, /node --test \.github\/scripts\/windows-confinement\.test\.mjs/)
})

// Execute the workflow's real pure PowerShell verifier, with kernel releases
// as data. No WSL executable, child process or host service is replaced.
const checkKernel = (kernel) => {
  const verifier = provision?.match(/^          function Assert-Wsl2Kernel[\s\S]*?^          \}/m)?.[0]
  assert.ok(verifier, "missing runtime WSL2 kernel verification")
  const result = spawnSync(process.env.SMITHERS_PWSH ?? "pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `${verifier}\nAssert-Wsl2Kernel $env:SMITHERS_TEST_KERNEL`
  ], { encoding: "utf8", env: { ...process.env, SMITHERS_TEST_KERNEL: kernel } })
  assert.ifError(result.error)
  return result
}

for (const kernel of [
  "5.15.167.4-microsoft-standard-WSL2",
  "6.6.87.2-microsoft-standard-WSL2",
  "6.6.87.2-microsoft-standard-WSL2\r\n"
]) {
  test(`accepts a running WSL2 kernel: ${JSON.stringify(kernel)}`, () => {
    const result = checkKernel(kernel)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /WSL2 kernel:/)
    assert.ok(result.stdout.includes(kernel.trim()))
  })
}

for (const kernel of [
  "",
  "4.4.0-19041-Microsoft",
  "6.8.0-1040-azure",
  "6.6.87.2-microsoft-standard-WSL2\n6.8.0-1040-azure",
  "6.6.87.2-microsoft-standard-WSL2-extra"
]) {
  test(`refuses missing, WSL1 or non-WSL2 kernel evidence: ${JSON.stringify(kernel)}`, () => {
    const result = checkKernel(kernel)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Expected a running WSL2 kernel/)
    assert.doesNotMatch(result.stdout, /WSL2 kernel:/)
  })
}
