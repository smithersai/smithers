// Stays .d.ts: TypeScript's resolver reads foreign-module declarations only from TypeScript declaration files.
/**
 * The checked foreign native port. Electrobun ships implementation TypeScript rather than declarations.
 * @since 1.0.0-rc.16
 */

/**
 * Native CEF window.
 * @category native
 * @since 1.0.0-rc.16
 */
export declare class BrowserWindow {
  constructor(
    options: {
      title?: string
      url: string
      frame?: { x: number; y: number; width: number; height: number }
      titleBarStyle: "hiddenInset"
      renderer: "cef"
      sandbox: boolean
      navigationRules: string
    }
  )
  readonly webview: { setNavigationRules(rules: Array<string>): void }
  close(): void
}
/**
 * System browser and directory chooser.
 * @category native
 * @since 1.0.0-rc.16
 */
export declare const Utils: {
  openExternal(url: string): boolean
  openFileDialog(
    options: { canChooseFiles: boolean; canChooseDirectory: boolean; allowsMultipleSelection: boolean }
  ): Promise<Array<string>>
}

/**
 * Packaged resource location.
 * @category native
 * @since 1.0.0-rc.16
 */
export declare const PATHS: { readonly RESOURCES_FOLDER: string }

/**
 * Compatibility marker supplied by the distributed native runtime, opener and chooser patch.
 * @category native
 * @since 1.0.0-rc.16
 */
export declare const SMITHERS_BUN14_COMPAT: unknown
