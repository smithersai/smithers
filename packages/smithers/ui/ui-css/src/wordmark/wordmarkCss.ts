import { tokens as t } from "../tokens";

/**
 * Wordmark CSS fragment, composed into `smithersUiCss` by uiCss.ts.
 *
 * The decorative SVG scales its geometry to its container, independently of
 * minimum font size. Rows scan in and ripple on hover; reduced motion disables both.
 */
export const wordmarkCss = `
.sui-wordmark { display:block; margin:0; width:100%; max-width:38rem; height:auto; fill:currentColor; color:${t.primary}; }
.sui-wordmark-row { --sui-wordmark-scan-edge:0 8% 0 0; --sui-wordmark-scan-offset:-2px; animation:sui-wordmark-scan 420ms cubic-bezier(0.16, 1, 0.3, 1) calc(40ms + var(--sui-wordmark-row) * 20ms) backwards; transition:transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1.15), opacity 380ms ease; transition-delay:calc(var(--sui-wordmark-row) * 22ms); }
.sui-wordmark-row:nth-child(even) { --sui-wordmark-scan-edge:0 0 0 8%; --sui-wordmark-scan-offset:2px; }
@media (hover: hover) { .sui-wordmark:hover .sui-wordmark-row { transform:translateY(calc((var(--sui-wordmark-row) - 2) * -2px)) scale(1.012); opacity:0.88; } }
.sui-wordmark:active .sui-wordmark-row { transform:translateY(2px) scale(0.99); opacity:0.7; transition-duration:100ms; transition-delay:0ms; }
@keyframes sui-wordmark-scan { from { clip-path:inset(var(--sui-wordmark-scan-edge)); transform:translateX(var(--sui-wordmark-scan-offset)); } to { clip-path:inset(0); transform:none; } }
`;
