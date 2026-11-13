import assert from "node:assert/strict"
import * as root from "@smthrs/plugin"
import * as Bind from "@smthrs/plugin/Bind"
import * as Contribution from "@smthrs/plugin/Contribution"
import * as Host from "@smthrs/plugin/Host"
import * as JsonSchema from "@smthrs/plugin/JsonSchema"
import * as Keys from "@smthrs/plugin/Keys"
import * as When from "@smthrs/plugin/When"
import * as Config from "@smthrs/plugin/Config"
import * as Hooks from "@smthrs/plugin/Hooks"
import * as Kernel from "@smthrs/plugin/Kernel"
import * as Plugin from "@smthrs/plugin/Plugin"
import * as PluginError from "@smthrs/plugin/PluginError"
import * as Plugins from "@smthrs/plugin/Plugins"
import * as Resolve from "@smthrs/plugin/Resolve"
import * as Load from "@smthrs/plugin/Load"
import * as Manifest from "@smthrs/plugin/Manifest"
import manifest from "@smthrs/plugin/package.json" with { type: "json" }

assert.strictEqual(manifest.name, "@smthrs/plugin")
assert.strictEqual(root.Bind.bind, Bind.bind)
assert.strictEqual(root.Contribution.empty, Contribution.empty)
assert.strictEqual(root.Host.pathOf, Host.pathOf)
assert.strictEqual(root.JsonSchema.resolve, JsonSchema.resolve)
assert.strictEqual(root.Keys.parse, Keys.parse)
assert.strictEqual(root.When.parse, When.parse)
assert.strictEqual(root.Config.resolve, Config.resolve)
assert.strictEqual(root.engineHooks, Hooks.engineHooks)
assert.strictEqual(root.Kernel.make, Kernel.make)
assert.strictEqual(root.make, Plugin.make)
assert.strictEqual(root.PluginError, PluginError.PluginError)
assert.strictEqual(root.Plugins.make, Plugins.make)
assert.strictEqual(root.Resolve.resolve, Resolve.resolve)
assert.strictEqual(root.Load.load, Load.load)
assert.strictEqual(root.Manifest.decode, Manifest.decode)

const rootError = new root.PluginError({ code: "invalid_plugin", message: "identity" })
assert.ok(rootError instanceof PluginError.PluginError)

const notExported = (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
await assert.rejects(import("@smthrs/plugin/internal/Boundary"), notExported)

// `./index` is an explicit export of the root file and shares its module identity.
const viaIndex = await import("@smthrs/plugin/index")
assert.strictEqual(viaIndex.PluginError, root.PluginError)
