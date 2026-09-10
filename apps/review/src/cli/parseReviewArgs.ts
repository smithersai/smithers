export type ReviewArgs = {
  repo: string;
  from: string;
  to: string;
  commit: string;
  background: string;
  title: string;
  out: string;
  db: string;
  executionId: string;
  review: boolean;
  narrate: boolean;
  verify: boolean;
  quiz: "off" | "auto" | "on";
  concurrency: number;
  timeout: number;
  split: boolean;
  publish: boolean;
  pr: string;
  open: boolean;
  help: boolean;
  version: boolean;
};

const QUIZ_MODES = new Set(["off", "auto", "on"]);

export function parseReviewArgs(argv: string[]): ReviewArgs {
  const args: ReviewArgs = {
    repo: ".",
    from: "",
    to: "",
    commit: "",
    background: "",
    title: "",
    out: "",
    db: "",
    executionId: "",
    review: true,
    narrate: true,
    verify: true,
    quiz: "auto",
    concurrency: 8,
    timeout: 10,
    split: false,
    publish: false,
    pr: "",
    open: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--from") args.from = next();
    else if (arg === "--to") args.to = next();
    else if (arg === "--commit") args.commit = next();
    else if (arg === "--background") args.background = next();
    else if (arg === "--title") args.title = next();
    else if (arg === "--out") args.out = next();
    else if (arg === "--db") args.db = next();
    else if (arg === "--execution-id") {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--")) {
        throw new Error("--execution-id requires a non-empty value");
      }
      args.executionId = value;
    } else if (arg === "--no-review") args.review = false;
    else if (arg === "--no-narrate") args.narrate = false;
    else if (arg === "--no-verify") args.verify = false;
    else if (arg === "--quiz") {
      const mode = next();
      if (!QUIZ_MODES.has(mode)) throw new Error(`--quiz must be one of off, auto, on (got "${mode}")`);
      args.quiz = mode as ReviewArgs["quiz"];
    } else if (arg === "--concurrency") args.concurrency = Number(next());
    else if (arg === "--timeout") args.timeout = Number(next());
    else if (arg === "--split") args.split = true;
    else if (arg === "--publish") args.publish = true;
    else if (arg === "--pr") args.pr = next();
    else if (arg === "--open") args.open = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--version") args.version = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else args.repo = arg;
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1)
    throw new Error("--concurrency must be a positive number");
  if (!Number.isFinite(args.timeout) || args.timeout < 1)
    throw new Error("--timeout must be a positive number of minutes");
  // Review targets are mutually exclusive; --pr derives its own --from/--to
  // after parsing, so combining them here would silently override the PR diff.
  const targets = [
    args.commit ? "--commit" : "",
    args.from || args.to ? "--from/--to" : "",
    args.pr ? "--pr" : "",
  ].filter(Boolean);
  if (targets.length > 1) {
    throw new Error(`conflicting review targets: ${targets.join(" and ")} cannot be combined — pick one`);
  }
  return args;
}
