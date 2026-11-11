/** @jsxImportSource react */
import { Context, Effect, Layer } from "effect";
import { createContext, type ReactNode, useContext } from "react";

/**
 * When a web page's frame has loaded, which ends `WebPageView`'s preview
 * cover. The live layer waits for the frame's own `load` event. A test that
 * needs the cover in place provides a layer whose `loaded` waits until the
 * test releases it, rather than racing the framed site.
 */
export class WebPageLoad extends Context.Service<WebPageLoad, {
  /**
   * Succeeds once `frame` has loaded the page it frames. Interrupted when the
   * frame shows another page or leaves the screen.
   */
  readonly loaded: (frame: HTMLIFrameElement) => Effect.Effect<void>;
}>()("@smthrs/ui/WebPageLoad") {
  /** The frame's own `load` event. */
  static readonly layer: Layer.Layer<WebPageLoad> = Layer.succeed(WebPageLoad, WebPageLoad.of({
    loaded: (frame) =>
      Effect.callback<void>((resume) => {
        const loaded = () => resume(Effect.void);
        frame.addEventListener("load", loaded, { once: true });
        return Effect.sync(() => frame.removeEventListener("load", loaded));
      }),
  }));
}

const WebPageLoadLayer = createContext<Layer.Layer<WebPageLoad>>(WebPageLoad.layer);

/** Every `WebPageView` inside uses `layer`'s `WebPageLoad`; outside one, `WebPageLoad.layer`. */
export function WebPageLoadProvider({ layer, children }: { readonly layer: Layer.Layer<WebPageLoad>; readonly children?: ReactNode }) {
  return <WebPageLoadLayer.Provider value={layer}>{children}</WebPageLoadLayer.Provider>;
}

/** The `WebPageLoad` layer a `WebPageView` here uses. */
export const useWebPageLoad = (): Layer.Layer<WebPageLoad> => useContext(WebPageLoadLayer);
