/** The complete source inventory, retaining logical identifiers across native renames. */
export interface SourceInventory {
  readonly typescript: ReadonlyArray<string>
  readonly native: ReadonlyArray<string>
  readonly logical: ReadonlyArray<string>
  readonly companions: ReadonlyArray<string>
}
export declare const sourceInventory: (root: string, manifest: ReadonlyArray<string>) => SourceInventory
export declare const checkSourceCoverage: (root: string, manifest: ReadonlyArray<string>) => SourceInventory
export declare const writeTypeScriptRoster: (root: string, manifest: ReadonlyArray<string>) => SourceInventory
