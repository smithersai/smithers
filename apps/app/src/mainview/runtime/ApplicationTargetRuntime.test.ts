import { describe, expect, test } from "bun:test"
import { APPLICATION_TARGET_META, loadApplicationTarget } from "./ApplicationTargetRuntime"

const fakeDocument = (content?: string): Pick<Document, "querySelector"> => ({
  querySelector: ((selector: string) =>
    selector === `meta[name="${APPLICATION_TARGET_META}"]` && content !== undefined
      ? { content }
      : null) as Document["querySelector"]
})

describe("runtime application target", () => {
  test("same artifact defaults to the serving self-host origin", async () => {
    await expect(loadApplicationTarget({ document: fakeDocument(), pageOrigin: "https://owner.test" }))
      .resolves.toMatchObject({ mode: "web-selfhost", baseUrl: "", ownership: "owner" })
  })

  test("runtime metadata selects explicit external Plue without a build fork", async () => {
    const configured = JSON.stringify({
      apiVersion: 1,
      mode: "web-plue",
      apiOrigin: "https://api.plue.test",
      auth: { kind: "bearer" },
      cors: "credentialed",
      developerExternal: true
    })
    await expect(loadApplicationTarget({ document: fakeDocument(configured), pageOrigin: "http://localhost:5173" }))
      .resolves.toMatchObject({ mode: "web-plue", baseUrl: "https://api.plue.test", launch: "none" })
  })

  test("native handshake wins over page metadata", async () => {
    await expect(loadApplicationTarget({
      document: fakeDocument("{bad-json"),
      pageOrigin: "http://127.0.0.1:4200",
      native: async () => ({
        apiVersion: 1,
        mode: "native-own",
        apiOrigin: "http://127.0.0.1:4200",
        auth: { kind: "session" },
        cors: "same-origin",
        developerExternal: false
      })
    })).resolves.toMatchObject({ mode: "native-own", launch: "supervisor", baseUrl: "" })
  })
})
