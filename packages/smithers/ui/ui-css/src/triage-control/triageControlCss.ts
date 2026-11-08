/**
 * `TriageControl`'s sheet: the state chip, the pending chip and the buttons on
 * one wrapping row. Chips are the compact badge the issue list uses, so a
 * triage state reads the same in the list and on the issue page.
 */
export const triageControlCss = `
.sui-triage-control { min-width:0; display:inline-flex; flex-wrap:wrap; align-items:center; gap:6px; }
.sui-triage-state, .sui-triage-pending { flex:none; min-height:18px; padding:0 6px; font-size:11px; }
`;
