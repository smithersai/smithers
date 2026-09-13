/** Boot hint only: the app's persisted store remains the authority for progress. */
export function hasSavedApp(read: (key: string) => string | null): boolean {
  try {
    // These are the app's existing backend/schema/envelope records. Reading
    // their presence avoids opening SQLite or importing app CSS into the home page.
    return ["smithers-mvp.persistenceBackend", "smithers-mvp.schemaVersion", "smithers-mvp.store"].some(key => read(key) !== null)
  } catch {
    return false
  }
}
