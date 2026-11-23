import { describe, expect, it } from "vitest"
import {
  allowingDocker,
  ci,
  docker,
  type Inventory,
  isRunnable,
  type Job,
  notReplayed,
  reasonsText
} from "../../src/contract/Inventory.vibe"
import { reasonsSentence } from "../../src/contract/Reasons.vibe"
import { containersIn, detailOf, markContainers } from "../../src/inventory/Containers.vibe"
import { markChanges, withInstalled } from "../../src/inventory/MachineChanges.vibe"

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

/** An inventory as the reader assembles one: each job marked for the machine, then for containers. */
const inventory = (jobs: ReadonlyArray<Job>): Inventory => ({
  version: 1,
  repository: "r",
  commit: "c",
  toolchains: [],
  jobs: jobs.map(markChanges).map(markContainers)
})

/** What the report says after the programs a job runs. */
const allow = "and a container daemon can reach every file of this machine; pass --allow-docker to replay it"

describe("a command that starts a container program", () => {
  it.each([
    ["docker build -t app .", ["docker"]],
    ["docker compose up -d", ["docker compose"]],
    ["docker --log-level debug -D compose up", ["docker compose"]],
    ["docker --context=ci compose up", ["docker compose"]],
    ["docker", ["docker"]],
    ["docker-compose -f ci.yml up", ["docker-compose"]],
    ["podman run --rm alpine true", ["podman"]],
    ["nerdctl ps", ["nerdctl"]],
    ["/usr/bin/docker info", ["docker"]],
    ["sudo docker run hello-world", ["docker"]],
    ["DOCKER_BUILDKIT=1 docker build .", ["docker"]],
    ["if ! docker info; then exit 1; fi", ["docker"]],
    ["bash -c 'podman build .'", ["podman"]],
    ["id=$(docker create app) && echo \"$id\"", ["docker"]],
    ["ls | xargs docker rmi", ["docker"]],
    ["timeout 60 docker pull alpine", ["docker"]],
    ["eval \"docker ps\"", ["docker"]],
    ["find . -name Dockerfile -exec docker build {} \;", ["docker"]],
    ["docker pull a\ndocker compose up\ndocker push a\npodman ps", ["docker", "docker compose", "podman"]]
  ])("%s", (command, started) => {
    expect(containersIn(command)).toEqual(started)
  })

  it.each([
    "npm test",
    "echo docker",
    "npm run docker:build",
    "./scripts/docker.sh",
    "cat Dockerfile",
    "command -v docker",
    "# docker build .",
    "git commit -m 'docker compose up'"
  ])("is not %s", (command) => {
    expect(containersIn(command)).toEqual([])
  })

  it("is read with the step's own variables, as the step's other commands are", () => {
    expect(containersIn("docker build .", { DOCKER_BUILDKIT: "1" })).toEqual(["docker"])
  })
})

describe("a job that starts a container program", () => {
  it("is marked once, with what it runs and what a person does about it", () => {
    const marked = markContainers(
      job(["docker compose up -d", "npm test", "docker compose down; docker system prune -f"])
    )
    expect(marked.unsupported).toEqual([{ feature: docker, detail: "runs docker compose and docker" }])
    expect(detailOf(["podman"])).toBe("runs podman")
    // The report gives the programs and what a person does to have the job replayed.
    expect(reasonsSentence(marked.unsupported)).toBe(`runs docker compose and docker, ${allow}`)
    expect(reasonsSentence([{ feature: docker, detail: "" }])).toBe(`runs a container program, ${allow}`)
    expect(isRunnable(marked)).toBe(false)
  })

  it("is returned as it is when no step does", () => {
    const plain = job(["npm ci", "npm test"])
    expect(markContainers(plain)).toBe(plain)
  })

  it("is not replayed, and the reason names the flag", () => {
    const read = inventory([job(["docker build ."]), job(["npm test"], { id: "ci.yml:test", name: "test" })])
    expect(ci(read).jobs.map((each) => each.id)).toEqual(["ci.yml:test"])
    const left = notReplayed(read)
    expect(left.map((entry) => entry.job)).toEqual(["ci.yml:build"])
    expect(reasonsText(left[0]?.reasons ?? [])).toBe("docker (runs docker)")
  })

  it("is replayed when the person allows Docker, and every other reason stays", () => {
    const read = inventory([
      job(["docker build ."]),
      job(["docker push app"], {
        id: "ci.yml:publish",
        name: "publish",
        unsupported: [{ feature: "environment", detail: "publish deploys to an environment" }]
      })
    ])
    const allowed = allowingDocker(read)
    expect(ci(allowed).jobs.map((each) => each.id)).toEqual(["ci.yml:build"])
    expect(notReplayed(allowed).map((entry) => reasonsText(entry.reasons))).toEqual(["environment"])
    // The inventory read is not changed: the same reading replays nothing without the flag.
    expect(ci(read).jobs).toEqual([])
  })

  it("still runs without the installs of packages the machine has, once Docker is allowed", () => {
    const read = inventory([job(["sudo apt-get install -y zsh", "docker build ."])])
    const here = withInstalled(read, () => true, () => true)
    // The install is settled whether or not Docker is allowed; what is left is the person's to say.
    expect(here.jobs[0]?.steps.map((step) => step.command)).toEqual(["docker build ."])
    expect(reasonsText(notReplayed(here)[0]?.reasons ?? [])).toBe("docker (runs docker)")
    expect(ci(allowingDocker(here)).jobs.map((each) => each.id)).toEqual(["ci.yml:build"])
  })

  it("names the missing package and the flag when it needs both", () => {
    const read = inventory([job(["sudo apt-get install -y fish", "docker build ."])])
    const here = withInstalled(read, () => true, () => false)
    expect(reasonsText(notReplayed(here)[0]?.reasons ?? [])).toBe(
      "docker (runs docker), changes-machine (install fish with apt-get to replay this job)"
    )
  })
})

describe("a job GitHub runs with containers it starts itself", () => {
  it("is never replayed, with or without the flag", () => {
    const services = job(["npm test"], {
      unsupported: [{ feature: "services", detail: "build runs service containers" }]
    })
    const read = allowingDocker(inventory([services]))
    expect(ci(read).jobs).toEqual([])
    expect(reasonsSentence(notReplayed(read)[0]?.reasons ?? [])).toBe(
      "needs service containers, which only GitHub starts; the job stays in your CI as it is"
    )
  })
})

it("lists the union of container commands over all matrix legs", () => {
  const matrix = ["echo", "docker", "podman", "docker"].map((cmd) => ({ cmd }))
  expect(markContainers(job(["${{ matrix.cmd }} info"], { matrix })).unsupported).toEqual([
    { feature: docker, detail: "runs docker and podman" }
  ])
})
