/**
 * Real Nix evaluation of imported files, in both environment declaration forms.
 * Opt in with SMITHERS_TEST_NIX_IMPORTS=1 and Nix on PATH in a trusted Linux
 * runner with a writable local Nix store. The fixture needs no nixpkgs download
 * and disables the Nix build sandbox for its host-bash derivation.
 */
import * as Input from "@smthrs/targets/Input"
import * as Nix from "@smthrs/targets/Nix"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import * as NixExec from "../src/NixExec.ts"
import * as PackageTree from "../src/PackageTree.ts"

const directories: Array<string> = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.env["SMITHERS_TEST_NIX_IMPORTS"] !== "1")(
  "Nix imported environment inputs",
  () => {
    beforeAll(() => {
      expect(process.platform, "The real Nix fixture requires a trusted Linux runner.").toBe("linux")
      expect(PackageTree.findOnPath("nix"), "The opted-in real Nix fixture requires nix on PATH.").toBeDefined()
    })

    it.each(["flake", "file"] as const)(
      "refreshes a memoized %s environment after an imported file changes and refuses a missing import",
      async (form) => {
        const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-nix-import-")))
        directories.push(root)
        await Fs.mkdir(NodePath.join(root, "nix"))
        const imported = NodePath.join(root, "nix/value.nix")
        await Fs.writeFile(imported, "\"before\"\n")
        await Fs.writeFile(
          NodePath.join(root, "shell.nix"),
          `derivation {
  name = "imported-environment";
  system = "${NixExec.hostSystem()}";
  builder = "/bin/bash";
  outputs = [ "out" ];
  args = [ "-c" "/bin/mkdir -p $out/bin" ];
  PATH = "/bin";
  SSL_CERT_FILE = import ./nix/value.nix;
}
`
        )
        await Fs.writeFile(
          NodePath.join(root, "flake.nix"),
          `{ outputs = { self }: { devShells.${NixExec.hostSystem()}.default = import ./shell.nix; }; }\n`
        )
        await Fs.writeFile(
          NodePath.join(root, "flake.lock"),
          JSON.stringify({ nodes: { root: {} }, root: "root", version: 7 })
        )
        const declaration = form === "flake"
          ? Nix.Environment({ flake: Input.file("//flake.nix") })
          : Nix.Environment({ file: Input.file("//shell.nix") })
        const options = {
          root,
          declaration,
          cacheDirectory: ".flows",
          // This tiny derivation uses the host's bash and mkdir instead of
          // downloading nixpkgs. Its only writes are its Nix store output.
          environment: { ...process.env, NIX_CONFIG: "sandbox = false\nbuild-users-group =\n" }
        }
        const first = await NixExec.resolveEnvironment(options)
        expect(first.variables["SSL_CERT_FILE"]).toBe("before")
        expect(await NixExec.resolveEnvironment(options)).toEqual(first)
        await Fs.writeFile(imported, "\"after\"\n")
        const second = await NixExec.resolveEnvironment(options)
        expect(second.inputs).toEqual(first.inputs)
        expect(second.storePath).not.toBe(first.storePath)
        expect(NixExec.layer(second)).not.toBe(NixExec.layer(first))
        expect(second.variables["SSL_CERT_FILE"]).toBe("after")
        expect(await Fs.readdir(NodePath.join(root, ".flows/nix"))).toHaveLength(2)
        await Fs.rm(imported)
        await expect(NixExec.resolveEnvironment(options)).rejects.toMatchObject({ code: "nix_evaluation_failed" })
      }
    )
  }
)
