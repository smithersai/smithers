import { expect, test } from "bun:test"
import { EXPORT_TARGETS } from "./targets"
import { wrapperFor } from "./deployment"
test("identity maintenance preserves durable account lookup and seals preexisting credentials in actual workerd", async () => {
  const built = await Bun.build({ entrypoints: [new URL("../../src/MaintenanceExport.ts", import.meta.url).pathname], target: "browser", format: "esm", minify: true })
  if (!built.success) throw new Error("Helper build failed")
  const legacy = `export class IdentityDurableObject { constructor(ctx){this.ctx=ctx} async fetch(request){const command=await request.json();const id=await this.ctx.storage.get("loginid:"+command.login);return Response.json({id:id??null,login:command.login})} } export default {fetch(){return new Response("original")}}`
  const child = Bun.spawn(["node", new URL("./identity-workerd.mjs", import.meta.url).pathname], { stdin: new Blob([JSON.stringify({ legacy, helper: await built.outputs[0]!.text(), wrapper: wrapperFor("index.js", EXPORT_TARGETS.identity) })]), stdout: "pipe", stderr: "pipe" })
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(error).toBe(""); expect(code).toBe(0); expect(out).toContain("unchanged account lookup passed")
}, 60000)
