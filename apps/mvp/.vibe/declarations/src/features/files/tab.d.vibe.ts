import { Layer } from "effect";
/** Answers the files channel of engine `name` for this tab's requests until its scope closes. */
export declare const tabFiles: (host: {
    readonly name: string;
}) => Layer.Layer<never, never, import("../../../../../src/features/files/actions.ts").FilesPage | import("./store.vibe").FilesStore | import("../../../../../node_modules/@smthrs/platform-browser/src/TabChannel.ts").TabChannel | import("../../../../../src/flows/requests.ts").TabRequests>;
