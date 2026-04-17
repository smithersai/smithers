export type HijackLaunchSpec = {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
};
