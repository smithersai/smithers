import { Layer } from "effect";
/** What the browser gives navigation: the engine's name, the app's origin, and the router's navigate. */
export interface NavigationHost {
    /** The engine's name: its navigation channel is `<name>/navigate`. */
    readonly name: string;
    /** The app's origin: a path is checked against it again before the tab moves. */
    readonly origin: string;
    /** Takes this tab to `path`, an app path: TanStack Router's `navigate`, outside React. */
    readonly navigate: (path: string) => void | Promise<void>;
}
/**
 * Answers the navigation channel for this tab's requests until its scope closes: goes to the call's path, checked once
 * more (`appPath`), and answers whether the tab moved. A navigate that throws or rejects answers that it did not move.
 */
export declare const tabNavigation: (host: NavigationHost) => Layer.Layer<never, never, import("../../../../../node_modules/@smthrs/platform-browser/src/TabChannel").TabChannel | import("../../../../../src/flows/requests").TabRequests>;
