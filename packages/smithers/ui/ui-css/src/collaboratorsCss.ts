import { tokens as t } from "./tokens";

/** Each lane's color, as `.sui-avatar[data-lane]` paints it, so a person's caret matches their avatar. */
const laneCss = [t.destructive, t.info, t.mutedForeground, t.warning, t.primary, t.success]
  .map((fallback, lane) =>
    `.sui-collaborator-caret[data-lane='${lane}'], .sui-collaborator-selection[data-lane='${lane}'] { --sui-collaborator:var(--lane-${lane}, ${fallback}); }`
  )
  .join("\n");

/** The carets' sheet: the mirror over its field, the caret line and its name flag, and a tinted selection. */
export const collaboratorsCss = `
.sui-collaborative-field { position:relative; display:grid; min-width:0; }
.sui-collaborator-carets { position:absolute; pointer-events:none; overflow:clip; overflow-clip-margin:1.4em; z-index:1; }
.sui-collaborator-mirror { position:absolute; top:0; left:0; margin:0; border-style:solid; border-color:transparent; color:transparent; background:transparent; overflow:visible; }
.sui-collaborator-caret { position:relative; }
.sui-collaborator-caret::before { content:""; position:absolute; left:-1px; top:0; bottom:0; width:2px; border-radius:2px; background:var(--sui-collaborator, ${t.primary}); }
.sui-collaborator-name { position:absolute; left:-1px; bottom:100%; padding:0 4px; border-radius:4px 4px 4px 0; background:var(--sui-collaborator, ${t.primary}); color:var(--avatar-ink, ${t.inverseText}); font:650 10px/14px ${t.fontSans}; white-space:nowrap; }
.sui-collaborator-selection { color:transparent; background:color-mix(in srgb, var(--sui-collaborator, ${t.primary}) 24%, transparent); border-radius:2px; }
${laneCss}
`;
