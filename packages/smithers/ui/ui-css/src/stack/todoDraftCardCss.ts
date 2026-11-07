/**
 * `TodoDraftCard`'s sheet: a card whose dashed border marks it as not on the
 * stack yet; its chips are the compact badge the issue list uses.
 */
import { tokens as t } from "../tokens";

export const todoDraftCardCss = `
.sui-todo-draft { min-width:0; display:grid; gap:12px; padding:14px 16px; border:1px dashed ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; }
.sui-todo-draft-header { min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.sui-todo-draft-name { font-size:13px; font-weight:650; }
.sui-todo-draft-private, .sui-todo-draft-source, .sui-todo-draft-refused { flex:none; min-height:18px; padding:0 6px; font-size:11px; }
.sui-todo-draft-repo { min-width:0; margin-left:auto; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; overflow-wrap:anywhere; }
.sui-todo-acceptance { display:grid; gap:4px; }
.sui-todo-acceptance-label { color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; font-weight:650; }
.sui-todo-acceptance-list { margin:0; padding:0 0 0 18px; display:grid; gap:2px; font-size:13px; }
.sui-todo-draft-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; }
.sui-todo-draft-refused { margin-right:auto; }
`;
