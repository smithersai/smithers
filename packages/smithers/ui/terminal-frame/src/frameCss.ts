import { xtermBaseCss } from "@smthrs/ui-css";

/**
 * The terminal frame's style sheet: xterm.js's own, and a screen that fills
 * the frame. The frame's runtime sets the background from the palette.
 */
export const terminalFrameCss = `${xtermBaseCss}
html[data-theme=light]{color-scheme:light}
html[data-theme=dark]{color-scheme:dark}
html,body{margin:0;height:100%;overflow:hidden}
[data-smithers-terminal]{position:absolute;top:8px;right:8px;bottom:8px;left:8px}
[data-smithers-terminal] .xterm{height:100%}
[data-smithers-terminal] .xterm-viewport{background-color:transparent}
`;
