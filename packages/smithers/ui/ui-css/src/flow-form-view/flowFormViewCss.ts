/**
 * The `form` template's sheet. `inline` packs the fields tighter for a
 * message; `full` gives them room on a page.
 */
import { tokens as t } from "../tokens";

export const flowFormViewCss = `
.sui-flow-form { min-width:0; display:grid; gap:10px; }
.sui-flow-form-fields { display:grid; gap:12px; }
.sui-flow-form-view[data-size='inline'] .sui-flow-form-fields { gap:8px; }
.sui-flow-form-view[data-size='full'] { padding:20px; }
.sui-flow-form-select { width:100%; }
.sui-flow-form-check { width:16px; height:16px; margin:0; accent-color:${t.primary}; }
.sui-flow-form-check:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-flow-form-problem { margin:0; color:${t.destructive}; font-size:${t.fontSizeCompact}; }
`;
