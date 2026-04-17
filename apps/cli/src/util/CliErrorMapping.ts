import type { CliExitCode } from "./CliExitCode.ts";

export type CliErrorMapping = {
    message: string;
    hint: string;
    exitCode: CliExitCode;
};
