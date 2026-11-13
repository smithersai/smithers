import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import { expect } from "vitest"

/** Inspect the host's effective permission representation, retaining the privacy gate. */
export const assertPrivatePath = (file: string) => {
  if (process.platform !== "win32") {
    const info = NodeFs.statSync(file)
    expect(info.mode & 0o777).toBe(info.isDirectory() ? 0o700 : 0o600)
    return
  }
  // Inspect explicit and inherited NTFS ACEs through the native .NET API;
  // stat.mode carries DOS attributes, and PSModulePath may name a different PowerShell.
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `
    $ErrorActionPreference = 'Stop'
    $sidType = [System.Security.Principal.SecurityIdentifier]
    $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trusted = @($current, 'S-1-5-18', 'S-1-5-32-544')
    $path = $env:SMITHERS_TEST_PRIVATE_FILE
    $acl = if ([System.IO.Directory]::Exists($path)) {
      [System.IO.Directory]::GetAccessControl($path)
    } else {
      [System.IO.File]::GetAccessControl($path)
    }
    if ($trusted -notcontains $acl.GetOwner($sidType).Value) { throw 'Unexpected file owner' }
    $rules = @($acl.GetAccessRules($true, $true, $sidType) | Where-Object { $_.AccessControlType -eq 'Allow' })
    if ($rules.Count -eq 0) { throw 'Missing private access rules' }
    foreach ($rule in $rules) {
      if ($trusted -notcontains $rule.IdentityReference.Value) { throw 'File grants access outside its owner, SYSTEM and administrators' }
    }
  `
  ], {
    env: { ...process.env, SMITHERS_TEST_PRIVATE_FILE: file },
    timeout: 10_000,
    stdio: "pipe"
  })
}
