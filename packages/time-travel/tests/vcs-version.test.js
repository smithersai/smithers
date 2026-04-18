import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { loadVcsTag } from "../src/vcs-version/index.js";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}
describe("loadVcsTag", () => {
    test("returns undefined when no tag exists", async () => {
        const { adapter } = createTestDb();
        const tag = await loadVcsTag(adapter, "run-1", 0);
        expect(tag).toBeUndefined();
    });
});
describe("tagSnapshotVcs", () => {
    // tagSnapshotVcs requires a live jj repository — it will return null
    // when jj is not available. We test the DB layer via loadVcsTag and
    // verify the no-jj path returns null gracefully.
    test("returns null when jj is not available (no crash)", async () => {
        const { adapter } = createTestDb();
        // Import dynamically so we don't fail at module level if jj helpers change
        const { tagSnapshotVcs } = await import("../src/vcs-version/index.js");
        // tagSnapshotVcs calls getJjPointer which returns null when jj is not installed
        // or the cwd is not a jj repo. This should return null without throwing.
        const result = await tagSnapshotVcs(adapter, "run-1", 0, {
            cwd: "/tmp/definitely-not-a-jj-repo",
        });
        expect(result).toBeNull();
    });
});
describe("rerunAtRevision", () => {
    test("returns restored:false when no VCS tag exists", async () => {
        const { adapter } = createTestDb();
        const { rerunAtRevision } = await import("../src/vcs-version/index.js");
        const result = await rerunAtRevision(adapter, "run-1", 0);
        expect(result.restored).toBe(false);
        expect(result.vcsPointer).toBeNull();
    });
});
describe("resolveWorkflowAtRevision", () => {
    test("returns null when no VCS tag exists", async () => {
        const { adapter } = createTestDb();
        const { resolveWorkflowAtRevision } = await import("../src/vcs-version/index.js");
        const result = await resolveWorkflowAtRevision(adapter, "run-1", 0, "/tmp/workspace");
        expect(result).toBeNull();
    });
});
