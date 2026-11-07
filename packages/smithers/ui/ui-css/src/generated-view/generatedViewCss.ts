/**
 * The generated view's sheet: the frame fills its width, an `inline` frame
 * takes the height its content reports, and a `full` frame fills its page.
 */
export const generatedViewCss = `
.sui-generated-view { position:relative; min-width:0; width:100%; }
.sui-generated-view[data-size='inline'] { min-height:80px; }
.sui-generated-view[data-size='full'] { height:100%; min-height:0; }
.sui-generated-view-frame { display:block; width:100%; border:0; background:transparent; }
.sui-generated-view[data-size='full'] .sui-generated-view-frame { height:100%; }
`;

/** What every frame document starts with, before the component sheet. */
export const frameBaseCss = "html,body{margin:0;padding:0;background:transparent;}body{overflow:hidden;}[data-smithers-view]{display:flow-root;}";
