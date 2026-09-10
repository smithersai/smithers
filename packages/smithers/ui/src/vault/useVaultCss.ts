import { useInjectUiCss } from "../styles";

/**
 * Inject the package stylesheet, idempotently. The vault fragment is composed
 * into `smithersUiCss`, so this is the whole delivery path for a vault view.
 */
export function useVaultCss(): void {
  useInjectUiCss();
}
