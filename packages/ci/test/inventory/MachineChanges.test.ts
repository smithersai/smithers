import { describe, expect, it } from "vitest"
import {
  blockers,
  changesMachine,
  ci,
  hostAction,
  type Inventory,
  isRunnable,
  type Job,
  noCommand,
  notReplayed,
  reasonsText
} from "../../src/contract/Inventory.vibe"
import {
  answers,
  changesIn,
  installsOf,
  markChanges,
  questionFor,
  questionsFor,
  startedIn,
  withInstalled
} from "../../src/inventory/MachineChanges.vibe"

const job = (commands: ReadonlyArray<string>, fields: Partial<Job> = {}): Job => ({
  id: "ci.yml:build",
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: "build",
  needs: [],
  triggers: ["push"],
  matrix: [],
  runsOn: "ubuntu-latest",
  steps: commands.map((command, index) => ({
    id: `ci.yml:build:${index + 1}`,
    command,
    cwd: "",
    env: {},
    secrets: []
  })),
  unsupported: [],
  ...fields
})

const inventory = (jobs: ReadonlyArray<Job>): Inventory => ({
  version: 1,
  repository: "r",
  commit: "c",
  toolchains: [],
  jobs: jobs.map(markChanges)
})

const details = (command: string, env: Readonly<Record<string, string>> = {}): ReadonlyArray<string> =>
  markChanges({ ...job([]), steps: [{ id: "s", command, cwd: "", env, secrets: [] }] }).unsupported
    .map((entry) => entry.detail)

const everywhere = () => true

describe("a command that changes the machine", () => {
  it.each([
    ["sudo make install", "runs sudo make"],
    ["sudo", "runs sudo"],
    ["sudo -n -u root -- whoami", "runs sudo whoami"],
    ["doas -u root reboot", "runs doas reboot"],
    ["su -c 'make install'", "runs su"],
    ["/usr/bin/sudo ls", "runs sudo ls"],
    ["FOO=1 sudo ls", "runs sudo ls"],
    ["sudo FOO=1 ls", "runs sudo ls"],
    ["sudo ./install.sh", "runs sudo ./install.sh"],
    ["curl -fsSL https://example.test/k | sudo gpg --dearmor -o /etc/k", "runs sudo gpg"],
    ["echo x | sudo tee /etc/x > /dev/null", "runs sudo tee"],
    ["if true; then sudo ls; fi", "runs sudo ls"],
    ["while true; do sudo ls; done", "runs sudo ls"],
    ["! sudo ls", "runs sudo ls"],
    ["{ sudo ls; }", "runs sudo ls"],
    ["(sudo ls)", "runs sudo ls"],
    ["f() { sudo ls; }", "runs sudo ls"],
    ["case x in a) sudo ls ;; esac", "runs sudo ls"],
    ["time sudo ls", "runs sudo ls"],
    ["a && sudo ls", "runs sudo ls"],
    ["a || sudo ls", "runs sudo ls"],
    ["a & sudo ls", "runs sudo ls"],
    ["echo $(sudo ls)", "runs sudo ls"],
    ["echo \"$(sudo ls)\"", "runs sudo ls"],
    ["echo `sudo ls`", "runs sudo ls"],
    ["echo \"`sudo ls`\"", "runs sudo ls"],
    ["echo `sudo \\`ls\\``", "runs sudo `ls`"],
    ["bash -c 'sudo ls'", "runs sudo ls"],
    ["sh -euc \"sudo ls\"", "runs sudo ls"],
    ["eval sudo ls", "runs sudo ls"],
    ["env FOO=1 sudo ls", "runs sudo ls"],
    ["env -u FOO sudo ls", "runs sudo ls"],
    ["timeout -k 5 10 sudo ls", "runs sudo ls"],
    ["timeout 5m sudo ls", "runs sudo ls"],
    ["nice -n 5 sudo ls", "runs sudo ls"],
    ["xargs -I {} sudo ls {}", "runs sudo ls"],
    ["xargs {} sudo ls", "runs sudo ls"],
    ["command sudo ls", "runs sudo ls"],
    ["exec sudo ls", "runs sudo ls"],
    ["find . -name x -exec sudo rm {} ;", "runs sudo rm"],
    ["find . -execdir sudo rm {} +", "runs sudo rm"],
    ["find . -ok sudo rm", "runs sudo rm"],

    ["s\\udo ls", "runs sudo ls"],
    ["'sudo' ls", "runs sudo ls"],
    ["\"sudo\" ls", "runs sudo ls"],
    ["echo $(a \\) ; sudo ls)", "runs sudo ls"]
  ])("%s", (command, line) => {
    expect(details(command)).toEqual([line])
  })

  it.each([
    ["sudo apt-get install -y zsh fish", "installs zsh and fish with apt-get"],
    ["apt install zsh", "installs zsh with apt"],
    ["sudo apt-get -o Dpkg::Use-Pty=0 install -y -t stable a b c", "installs a, b and c with apt-get"],
    ["$SUDO apt-get install x", "installs x with apt-get"],
    ["${SUDO} apt-get install x", "installs x with apt-get"],
    ["sudo env DEBIAN_FRONTEND=noninteractive apt-get install x", "installs x with apt-get"],
    ["sudo apt-get update && sudo apt-get install x", "installs x with apt-get"],
    ["sudo apt-get install x; sudo apt-get install x y", "installs x and y with apt-get"],
    ["dnf install -y x", "installs x with dnf"],
    ["yum install x", "installs x with yum"],
    ["microdnf install x", "installs x with microdnf"],
    ["zypper --non-interactive in x", "installs x with zypper"],
    ["apk add --no-cache x", "installs x with apk"],
    ["brew install x", "installs x with brew"],
    ["port install x", "installs x with port"],
    ["choco install x -y", "installs x with choco"],
    ["winget install --id x y", "installs y with winget"],
    ["scoop install x", "installs x with scoop"],
    ["snap install x --channel=stable", "installs x with snap"],
    ["pacman -S --noconfirm x", "installs x with pacman"],
    ["pacman --sync x", "installs x with pacman"],
    ["pacman -Sy x", "installs x with pacman"]
  ])("%s", (command, line) => {
    expect(details(command)).toEqual([line])
  })

  it.each([
    ["apt-get remove x", "runs apt-get remove"],
    ["apt-get install", "runs apt-get install"],
    ["apt-get update", "runs apt-get update"],
    ["brew update", "runs brew update"],
    ["brew services start x", "runs brew services"],
    ["brew tap a/b", "runs brew tap"],
    ["dnf makecache", "runs dnf makecache"],
    ["scoop update x", "runs scoop update"],
    ["dpkg -i x.deb", "runs dpkg"],
    ["rpm -i x.rpm", "runs rpm"],
    ["pacman -R x", "runs pacman"],
    ["pacman -Syu", "runs pacman -Syu"],
    ["pacman -Scc", "runs pacman -Scc"],
    ["pacman -Sy", "runs pacman -Sy"],
    ["pacman -S", "runs pacman -S"],
    ["systemctl start x", "runs systemctl start"],
    ["sudo systemctl daemon-reload", "runs systemctl daemon-reload"],
    ["service x restart", "runs service restart"],
    ["service x", "runs service"],
    ["launchctl load x", "runs launchctl load"],
    ["npm install -g x", "runs npm install -g"],
    ["npm i --global x", "runs npm i -g"],
    ["npm uninstall --location=global x", "runs npm uninstall -g"],
    ["npm link", "runs npm link"],
    ["corepack enable", "runs corepack enable"],
    ["gem install x", "runs gem install"],
    ["pip install --break-system-packages x", "runs pip install --break-system-packages"],
    ["pip3.12 uninstall --break-system-packages x", "runs pip uninstall --break-system-packages"],
    ["python3 -m pip install --break-system-packages x", "runs pip install --break-system-packages"],
    ["PIP_BREAK_SYSTEM_PACKAGES=1 pip install x", "runs pip install --break-system-packages"],
    ["uv pip install --system x", "runs uv pip --system"]
  ])("%s", (command, line) => {
    expect(details(command)).toEqual([line])
  })

  it("lists what a job runs, then what it installs, each once", () => {
    const marked = markChanges(job([
      "sudo install -d /etc/k\ncurl k | sudo gpg --dearmor -o /etc/k/a.gpg\necho deb | sudo tee /etc/s.list",
      "sudo apt-get update\nsudo apt-get install --yes zsh fish nushell=0.116.1-0",
      "sudo gpg --version"
    ]))
    expect(marked.unsupported).toEqual([
      { feature: changesMachine, detail: "runs sudo install, sudo gpg and sudo tee" },
      { feature: changesMachine, detail: "installs zsh, fish and nushell=0.116.1-0 with apt-get" }
    ])
    expect(isRunnable(marked)).toBe(false)
    expect(blockers(marked)).toHaveLength(2)
    expect(reasonsText(blockers(marked))).toBe(
      "changes-machine (runs sudo install, sudo gpg and sudo tee; installs zsh, fish and nushell=0.116.1-0 with apt-get)"
    )
  })

  it("reads the step's own environment", () => {
    expect(details("pip install x", { PIP_BREAK_SYSTEM_PACKAGES: "1" })).toHaveLength(1)
    expect(details("gem install x", { GEM_HOME: "vendor" })).toEqual([])
  })
})

// A replay's stand-in for `sudo` refuses, so a step is read as it runs on a machine where `sudo -n true` fails.
describe("a step that asks before it uses sudo", () => {
  const asked = [
    "if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then",
    "  echo 'no sudo here; the lock timeout stays as it is'",
    "  exit 0",
    "fi",
    "printf 'DPkg::Lock::Timeout \"600\";\\n' | sudo tee /etc/apt/apt.conf.d/99-lock-timeout >/dev/null"
  ].join("\n")

  it("does not keep its job out: what it keeps for a machine whose sudo works never runs", () => {
    const marked = markChanges(job([asked, "npm test"]))
    expect(marked.unsupported).toEqual([])
    expect(isRunnable(marked)).toBe(true)
  })

  // A directory first on PATH could hold a `sudo` of its own, and a file bash reads first could define one.
  it.each<[string, ReadonlyArray<string>, Partial<Job["steps"][number]>]>([
    ["adds to PATH for the steps after it", ["echo \"$PWD/tools\" >> \"$GITHUB_PATH\"", asked], {}],
    ["sets PATH", [`export PATH="$PWD/tools:$PATH"\n${asked}`], {}],
    ["is given a PATH of its own", [asked], { env: { PATH: "/opt/tools/bin:/usr/bin" } }],
    ["is given a file its shell reads first", [asked], { env: { BASH_ENV: "./env.sh" } }],
    ["is given a PATH worked out while the job runs", [asked], { runner: "__ci_step() {\nexport PATH=\"$__v1\"\n}" }]
  ])("keeps its job out when a step of the job %s", (_name, commands, fields) => {
    const made = job(commands)
    const marked = markChanges({ ...made, steps: made.steps.map((step) => ({ ...step, ...fields })) })
    expect(marked.unsupported).toEqual([{ feature: changesMachine, detail: "runs sudo true and sudo tee" }])
    expect(isRunnable(marked)).toBe(false)
  })

  it("reads a job whose steps name other variables that end in PATH", () => {
    const marked = markChanges(job([`echo "$NODE_PATH $GOPATH"`, asked]))
    expect(marked.unsupported).toEqual([])
  })

  it("keeps its job out when another step uses sudo without asking", () => {
    const marked = markChanges(job([asked, "sudo systemctl restart docker"]))
    expect(marked.unsupported).toEqual([{ feature: changesMachine, detail: "runs systemctl restart" }])
    expect(isRunnable(marked)).toBe(false)
  })
})

describe("a command that leaves the machine alone", () => {
  it.each([
    "npm test",
    "echo sudo",
    "echo 'sudo apt-get install x'",
    "echo \"sudo apt-get install x\" # sudo",
    "# sudo ls",
    "grep sudo file",
    "./sudo ls",
    "scripts/sudo ls",
    "echo x > sudo",
    "echo x 2>&1 sudo",
    "echo x >",
    "command -v sudo",
    "command -V sudo",
    "env",
    "timeout 5",
    "nohup",
    "bash script.sh",
    "bash -c",
    "sh",
    "find . -name sudo",
    "FOO=1",
    "$FOO",
    "$SUDO make",
    "'unterminated",
    "\"unterminated",
    "`unterminated",
    "$(unterminated",
    "${unterminated",
    "trailing \\",
    "\"trailing \\",
    "echo $'x' $? $1",
    "echo ${{ matrix.sudo }}",
    "echo a\\\nb",
    "apt-get --version",
    "apt-cache policy x",
    "apt list --installed",
    "brew --prefix",
    "brew list",
    "dnf list",
    "dpkg",
    "dpkg -s x",
    "dpkg --print-architecture",
    "rpm -qa",
    "pacman",
    "pacman -Q",
    "pacman --version",
    "pacman -Ss x",
    "systemctl",
    "systemctl status x",
    "systemctl --version",
    "service",
    "service --status-all",
    "service x status",
    "launchctl list",
    "npm install",
    "npm ci",
    "npm link x",
    "npm",
    "pnpm add -g x",
    "bun add -g x",
    "deno install -g x",
    "yarn global add x",
    "cargo install x",
    "go install ./...",
    "corepack prepare",
    "corepack",
    "gem install --user-install x",
    "gem install -i vendor x",
    "GEM_HOME=vendor gem install x",
    "gem list",
    "gem",
    "pip install x",
    "pip list",
    "pip",
    "python -m pip install x",
    "python -m venv .venv",
    "python",
    "uv pip install x",
    "uv sync"
  ])("%s", (command) => {
    expect(details(command)).toEqual([])
  })

  it("follows commands inside commands only so far", () => {
    const nested = Array.from({ length: 12 }).reduce<string>((text) => `$(${text})`, "sudo ls")
    expect(changesIn(`echo ${nested}`)).toEqual([])
    expect(changesIn("echo $(echo $(sudo ls))")).toHaveLength(1)
    const wrapped = Array.from({ length: 12 }).reduce<string>((text) => `env ${text}`, "sudo ls")
    expect(changesIn(wrapped)).toEqual([])
  })
})

describe("a step that only installs packages", () => {
  it.each([
    ["sudo apt-get install -y zsh", [{ manager: "apt-get", packages: ["zsh"] }]],
    ["sudo -E apt-get install zsh", [{ manager: "apt-get", packages: ["zsh"] }]],
    ["DEBIAN_FRONTEND=noninteractive sudo apt-get install zsh", [{ manager: "apt-get", packages: ["zsh"] }]],
    ["set -euxo pipefail\nsudo apt-get update\nsudo apt-get install a\nsudo apt-get install b=1", [
      { manager: "apt-get", packages: ["a"] },
      { manager: "apt-get", packages: ["b=1"] }
    ]],
    ["sudo apt-get update", []],
    ["sh -cu 'sudo apt-get install zsh'", [{ manager: "apt-get", packages: ["zsh"] }]],
    ["brew install jq", [{ manager: "brew", packages: ["jq"] }]],
    ["dnf install -y jq", [{ manager: "dnf", packages: ["jq"] }]],
    ["apk add jq", [{ manager: "apk", packages: ["jq"] }]],
    ["pacman -S jq", [{ manager: "pacman", packages: ["jq"] }]]
  ])("%s", (command, installs) => {
    expect(installsOf(command)).toEqual(installs)
  })

  it.each([
    "",
    "for x in a; do sudo apt-get install $x; done",
    "sudo apt-get install $PACKAGES",
    "PACKAGES=$X sudo apt-get install zsh",
    "echo start; sudo apt-get install zsh",
    "sudo apt-get install zsh | tee log",
    "sudo apt-get install zsh &",
    "sudo apt-get install zsh || true",
    "if true; then sudo apt-get install zsh; fi",
    "sudo apt-get install ./local.deb",
    "sudo apt-get install zsh-",
    "sudo apt-get remove zsh",
    "brew install --cask iterm2",
    "port install jq",
    "sudo gpg --version",
    "dnf install @development",
    "sh -c"
  ])("%s is more than that", (command) => {
    expect(installsOf(command)).toBeUndefined()
  })
})

describe("asking the machine", () => {
  it("asks each package manager in its own words", () => {
    expect(questionFor("apt-get", "zsh")?.argv).toEqual(["dpkg", "-s", "zsh"])
    expect(questionFor("aptitude", "zsh/stable")?.argv).toEqual(["dpkg", "-s", "zsh"])
    expect(questionFor("apt", "libc6:amd64")?.argv).toEqual(["dpkg", "-s", "libc6:amd64"])
    expect(questionFor("dnf", "jq")?.argv).toEqual(["rpm", "-q", "jq"])
    expect(questionFor("zypper", "jq")?.argv).toEqual(["rpm", "-q", "jq"])
    expect(questionFor("brew", "owner/tap/jq")?.argv).toEqual(["brew", "list", "--versions", "owner/tap/jq"])
    expect(questionFor("pacman", "jq")?.argv).toEqual(["pacman", "-Q", "jq"])
    expect(questionFor("apk", "jq")?.argv).toEqual(["apk", "info", "-e", "jq"])
    expect(questionFor("apt-get", "g++")?.name).toBe("g++")
  })

  it("does not ask about what is no package name, or a manager it cannot ask", () => {
    expect(questionFor("apt-get", "./x.deb")).toBeUndefined()
    expect(questionFor("apt-get", "${{ matrix.package }}")).toBeUndefined()
    expect(questionFor("dnf", "a/b")).toBeUndefined()
    expect(questionFor("snap", "jq")).toBeUndefined()
  })

  it("takes yes from dpkg only for a package that is installed, at the version named", () => {
    const pinned = questionFor("apt-get", "zsh=5.9") as NonNullable<ReturnType<typeof questionFor>>
    const status = "Package: zsh\nStatus: install ok installed\nVersion: 5.9\n"
    expect(answers(pinned, status)).toBe(true)
    expect(answers(pinned, status.replace("5.9", "5.8"))).toBe(false)
    expect(answers(pinned, "Status: deinstall ok config-files\nVersion: 5.9\n")).toBe(false)
    expect(answers(pinned, "")).toBe(false)
  })

  it("takes yes from the other managers when they print anything", () => {
    const question = questionFor("brew", "jq") as NonNullable<ReturnType<typeof questionFor>>
    expect(answers(question, "jq 1.7\n")).toBe(true)
    expect(answers(question, "\n")).toBe(false)
  })
})

describe("an inventory on a machine", () => {
  const installs = job(["sudo apt-get update", "sudo apt-get install -y zsh fish", "make test"])

  it("drops the install steps of a job when every package is there, and the job runs", () => {
    const read = inventory([installs])
    expect(isRunnable(read.jobs[0] as Job)).toBe(false)
    expect(questionsFor(read, everywhere).map((question) => question.name)).toEqual(["zsh", "fish"])
    const here = withInstalled(read, everywhere, () => true)
    expect(ci(here).jobs[0]?.steps.map((step) => step.command)).toEqual(["make test"])
    expect(ci(here).jobs[0]?.steps[0]?.id).toBe("ci.yml:build:3")
    expect(notReplayed(here)).toEqual([])
  })

  it("names the packages that are missing, and only those", () => {
    const here = withInstalled(inventory([installs]), everywhere, (_manager, name) => name === "zsh")
    expect(ci(here).jobs).toEqual([])
    expect(notReplayed(here)).toEqual([{
      job: "ci.yml:build",
      reasons: [{ feature: changesMachine, detail: "install fish with apt-get to replay this job" }]
    }])
  })

  it("lists a package once, under each manager that needs it", () => {
    const twice = job(["apt-get install a b", "apt-get install b", "brew install c"])
    const here = withInstalled(inventory([twice]), everywhere, () => false)
    expect((here.jobs[0] as Job).unsupported.map((entry) => entry.detail)).toEqual([
      "install a and b with apt-get to replay this job",
      "install c with brew to replay this job"
    ])
  })

  it("lists a job with nothing left to run as having no command", () => {
    const here = withInstalled(inventory([job(["sudo apt-get install zsh"])]), everywhere, () => true)
    expect(ci(here).jobs).toEqual([])
    expect((here.jobs[0] as Job).unsupported.map((entry) => entry.feature)).toEqual([hostAction])
    expect(notReplayed(here)[0]?.reasons[0]?.feature).toBe(noCommand)
  })

  it("leaves a job that does anything else to the machine", () => {
    const other = job(["sudo apt-get install zsh", "sudo gpg --version"])
    const read = inventory([other])
    expect(questionsFor(read, everywhere)).toEqual([])
    expect(withInstalled(read, everywhere, () => true).jobs).toEqual(read.jobs)
  })

  it("leaves a job another reason keeps out", () => {
    const held = job(["sudo apt-get install zsh"], { unsupported: [{ feature: "uses", detail: "x" }] })
    const read = inventory([held])
    expect(questionsFor(read, everywhere)).toEqual([])
    expect(withInstalled(read, everywhere, () => true).jobs).toEqual(read.jobs)
  })

  it("leaves a job with no change, one that is no CI, and one that does not run here", () => {
    const plain = job(["make test"])
    const nightly = job(["sudo apt-get install zsh"], { id: "ci.yml:nightly", triggers: ["schedule"] })
    const read = inventory([plain, nightly])
    expect(questionsFor(read, everywhere)).toEqual([])
    expect(withInstalled(read, everywhere, () => true).jobs).toEqual(read.jobs)
    const elsewhere = inventory([installs])
    expect(questionsFor(elsewhere, () => false)).toEqual([])
    expect(withInstalled(elsewhere, () => false, () => true).jobs).toEqual(elsewhere.jobs)
  })
})

describe("shell token boundaries", () => {
  it("ignores literal document data and retains commands after the delimiter", () => {
    expect(startedIn("cat <<-'END'\n\tjust demo\n\tEND\nreport")).toEqual([
      { name: "cat", args: [] },
      { name: "report", args: [] }
    ])
    expect(startedIn("cat <<\"OTHER\"\nword\nOTHER")).toEqual([{ name: "cat", args: [] }])
    expect(startedIn("cat <<END\nplain words \\x $(first) `second`\nEND").map((entry) => entry.name))
      .toEqual(["cat", "first", "second"])
    expect(startedIn("sh <<END\nreport\nEND").map((entry) => entry.name)).toEqual(["sh", "report"])
  })

  it("retains the command word after closing a descriptor or a quoted substitution", () => {
    expect(startedIn(">&- report")).toEqual([{ name: "report", args: [] }])
    expect(startedIn("echo ${VALUE:-'{'}; report").at(-1)?.name).toBe("report")
    expect(startedIn("echo $(echo \")\"); report").at(-1)?.name).toBe("report")
    expect(startedIn("coproc report { observe; }").map((entry) => entry.name)).toContain("observe")
    expect(startedIn("coproc observe").map((entry) => entry.name)).toContain("observe")
    expect(startedIn("function report { observe; }").map((entry) => entry.name)).toContain("observe")
  })

  it("restricts presence-only shortcuts to known install options", () => {
    expect(installsOf("apt-get install --reinstall x")).toBeUndefined()
    expect(installsOf("apt-get install x >log")).toBeUndefined()
    expect(installsOf("pacman -S --overwrite x")).toBeUndefined()
    expect(changesIn("dpkg --status --install")).toEqual([{ kind: "other", what: "dpkg" }])
    expect(changesIn("dpkg --status-fd 1")).toEqual([{ kind: "other", what: "dpkg" }])
  })
})

describe("commands within shell words", () => {
  it.each([
    ["echo ${VALUE:-$(observe)}", "observe"],
    ["echo \"${A:-${B:-\`observe\`}}\"", "observe"],
    ["cat <<END\n${A:-${B:-$(observe)}}\nEND", "observe"],
    ["echo \"${VALUE:-$(printf '}'; observe)}\"", "observe"],
    ["echo \"$(case value in v*) observe ;; other) report ;; esac)\"", "observe"],
    ["echo \"$(case x in (x) case y in y) observe ;; esac ;; esac)\"", "observe"],
    ["echo \"$(echo case; observe)\"", "observe"],
    ["echo \"$(echo `printf ')'`)\"; observe", "observe"],
    ["echo \"$(echo \"${VALUE:-$(printf '}')}\")\"; observe", "observe"],
    ["echo \"$(case x in esac)\"; observe", "observe"],
    ["echo \"$(case a in a) printf in esac ;; b) observe ;; esac)\"", "observe"],
    ["echo \"$(echo in esac)\"; observe", "observe"],
    ["echo \"$(case x in x) echo ok ;; case ) observe ;; esac)\"", "observe"],
    ["bash -eoc pipefail observe", "observe"],
    ["bash --norc -eo pipefail -c observe", "observe"],
    ["echo \"$(case x in\n esac)\"; observe", "observe"],
    ["echo \"$(\n{ ! case x\nin\nx|esac) observe ;; esac; }\n)\"", "observe"],
    ["echo \"$(if case x in x) observe ;; esac; then echo ok; fi)\"", "observe"],
    ["echo \"$(echo if then case; echo ok)\"; observe", "observe"],
    ["echo \"$(case x in x) echo x ;; (y) observe ;; esac)\"", "observe"],
    ["echo \"$(# unmatched )\n\\\ncase x in x) observe ;; esac)\"", "observe"],
    ["echo \"$(#unfinished", "echo"],
    ["echo \"$(case value in v*) observe; esac)\"", "observe"],
    ["timeout 1.5m observe", "observe"],
    ["bash --rcfile init --init-file next +e -o pipefail +O extglob -c 'observe' ", "observe"],
    ["bash -c -O extglob +o pipefail +u 'observe'", "observe"],
    ["echo \"${MSG:-can't}\"; observe", "observe"],
    ["echo ${unfinished; observe", "observe"],
    ["$'observe' $'it\\'s open'; report", "report"],
    ["$'observe' data", "observe"],
    ["$'obs\\\\erve'", "obs\\erve"],
    ["$'obs\\qerve'", "obs\\qerve"],
    ["$'\\157\\x62\\u0073\\U00000065rve'", "observe"],
    ["$'obs\\000gone'", "obs"],
    ["$'\\cA\\n\\UFFFFFFFF'", "\x01\n\\UFFFFFFFF"],
    ["echo $(echo $'can\\'t'); observe", "observe"],
    ["$'unfinished", "unfinished"],
    ["exec -c observe", "observe"],
    ["exec -a identity observe", "observe"],
    ["command -p observe", "observe"],
    ["command -p observe -v", "observe"],
    ["setsid -c observe", "observe"],
    ["xargs -p -n 2 observe", "observe"],
    ["env -C /work -S 'observe -a' extra", "observe"],
    ["env --split-string='observe first' \"it's literal\"", "observe"],
    ["env -S'observe first'", "observe"],
    ["timeout --signal TERM 5 observe", "observe"],
    ["time -p observe", "observe"],
    ["sh -c -e 'observe first'", "observe"],
    ["sh -c -- 'observe second'", "observe"],
    ["bash <<< 'observe text'", "observe"],
    ["<<< 'observe text' env bash", "observe"]
  ])("finds the program in %s", (source, program) => {
    expect(startedIn(source).map(({ name }) => name)).toContain(program)
  })

  it("treats repeated keyword arguments as data across long whitespace", () => {
    const source = "echo \"$(printf " + "then ".repeat(1000) + " ".repeat(8192) + "case)\"; observe"
    expect(startedIn(source).at(-1)?.name).toBe("observe")
  })

  it("preserves split-string trailing arguments as words and leaves ordinary stdin as data", () => {
    expect(startedIn("env --split-string='observe --check' \"it's literal\"").at(-1)).toEqual({
      name: "observe",
      args: ["--check", "it's literal"]
    })
    expect(startedIn("bash script.sh <<< 'observe text'").map(({ name }) => name)).toEqual(["bash"])
    expect(startedIn("bash -s arg <<< 'observe text'").at(-1)?.name).toBe("observe")
    expect(startedIn("echo ${X:-'$(data)'}").map(({ name }) => name)).toEqual(["echo"])
    expect(startedIn("echo ${X:-\"can't $(observe)\"}").map(({ name }) => name)).toEqual(["observe", "echo"])
    expect(startedIn("env -S")).toEqual([{ name: "env", args: ["-S"] }])
    expect(startedIn("cat <<< 'observe text'")).toEqual([{ name: "cat", args: [] }])
  })

  it("distinguishes rpm macro shell evaluation from literal evaluation", () => {
    expect(changesIn("rpm --eval '%(true)'")).toEqual([{ kind: "other", what: "rpm" }])
    expect(changesIn("rpm -E '%_arch'")).toEqual([])
    expect(changesIn("rpm -q '%(true)'")).toEqual([])
  })

  it("uses every matrix leg before removing a shared install step", () => {
    const source = (cmds: ReadonlyArray<string>) =>
      inventory([
        job(["${{ matrix.cmd }}", "test"], { matrix: cmds.map((cmd) => ({ cmd })) })
      ])
    const allInstalls = source(["brew install a", "brew install b", "brew install a"])
    expect(allInstalls.jobs[0]?.unsupported).toEqual([{
      feature: changesMachine,
      detail: "installs a and b with brew"
    }])
    expect(questionsFor(allInstalls, everywhere).map((question) => question.name)).toEqual(["a", "b"])
    expect(withInstalled(allInstalls, everywhere, () => true).jobs[0]?.steps.map((step) => step.command)).toEqual([
      "test"
    ])
    for (const read of [source(["test", "brew install a"]), source(["test", "brew update", "corepack enable"])]) {
      expect(read.jobs[0]?.unsupported.length).toBeGreaterThan(0)
      expect(withInstalled(read, everywhere, () => true)).toEqual(read)
    }
  })
})
