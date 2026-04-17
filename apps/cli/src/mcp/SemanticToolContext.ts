import type { findAndOpenDb } from "../find-db.js";

export type SemanticToolContext = {
    cwd: () => string;
    openDb: typeof findAndOpenDb;
};
