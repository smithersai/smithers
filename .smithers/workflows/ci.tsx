import { Workflow, Task, Parallel, on } from "@smithers-ai/workflow";

// Cloud discovers this file and runs each task in an independent Linux sandbox.
// Workspace includes package typechecks, tests, lint and docs. See cloud.sh for
// tool bootstrap and the gates excluded from this Linux, credential-free lane.
export default () => (
  <Workflow name="CI" triggers={[on.push({ branches: ["main"] }), on.manualDispatch({})]}>
    <Parallel>
      <Task id="workspace" secrets={[]}>{`bash scripts/ci/cloud.sh workspace`}</Task>
      <Task id="examples" secrets={[]}>{`bash scripts/ci/cloud.sh examples`}</Task>
      <Task id="scripts" secrets={[]}>{`bash scripts/ci/cloud.sh scripts`}</Task>
      <Task id="flows" secrets={[]}>{`bash scripts/ci/cloud.sh flows`}</Task>
      <Task id="jsdoc" secrets={[]}>{`bash scripts/ci/cloud.sh jsdoc`}</Task>
      <Task id="script-lint" secrets={[]}>{`bash scripts/ci/cloud.sh script-lint`}</Task>
      <Task id="jsdoc-rules" secrets={[]}>{`bash scripts/ci/cloud.sh jsdoc-rules`}</Task>
      <Task id="factory-harness" secrets={[]}>{`bash scripts/ci/cloud.sh factory-harness`}</Task>
      <Task id="agent-eval" secrets={[]}>{`bash scripts/ci/cloud.sh agent-eval`}</Task>
      <Task id="agent-check" secrets={[]}>{`bash scripts/ci/cloud.sh agent-check`}</Task>
      <Task id="authoring-eval" secrets={[]}>{`bash scripts/ci/cloud.sh authoring-eval`}</Task>
      <Task id="authoring-check" secrets={[]}>{`bash scripts/ci/cloud.sh authoring-check`}</Task>
      <Task id="swebench" secrets={[]}>{`bash scripts/ci/cloud.sh swebench`}</Task>
      <Task id="swebench-check" secrets={[]}>{`bash scripts/ci/cloud.sh swebench-check`}</Task>
      <Task id="server" secrets={[]}>{`bash scripts/ci/cloud.sh server`}</Task>
      <Task id="review-app" secrets={[]}>{`bash scripts/ci/cloud.sh review-app`}</Task>
      <Task id="bug-worker" secrets={[]}>{`bash scripts/ci/cloud.sh bug-worker`}</Task>
      <Task id="status-site" secrets={[]}>{`bash scripts/ci/cloud.sh status-site`}</Task>
      <Task id="project-copy" secrets={[]}>{`bash scripts/ci/cloud.sh project-copy`}</Task>
      <Task id="site" secrets={[]}>{`bash scripts/ci/cloud.sh site`}</Task>
      <Task id="docs" secrets={[]}>{`bash scripts/ci/cloud.sh docs`}</Task>
      <Task id="review-eval" secrets={[]}>{`bash scripts/ci/cloud.sh review-eval`}</Task>
      <Task id="review-check" secrets={[]}>{`bash scripts/ci/cloud.sh review-check`}</Task>
      <Task id="recommend-eval" secrets={[]}>{`bash scripts/ci/cloud.sh recommend-eval`}</Task>
      <Task id="recommend-check" secrets={[]}>{`bash scripts/ci/cloud.sh recommend-check`}</Task>
      <Task id="workflow-drift" secrets={[]}>{`bash scripts/ci/cloud.sh workflow-drift`}</Task>
      <Task id="factory-drift" secrets={[]}>{`bash scripts/ci/cloud.sh factory-drift`}</Task>
      <Task id="target-index" secrets={[]}>{`bash scripts/ci/cloud.sh target-index`}</Task>
      <Task id="ui-check" secrets={[]}>{`bash scripts/ci/cloud.sh ui-check`}</Task>
      <Task id="ui-tests" secrets={[]}>{`bash scripts/ci/cloud.sh ui-tests`}</Task>
      <Task id="ui-browser" secrets={[]}>{`bash scripts/ci/cloud.sh ui-browser`}</Task>
      <Task id="rust-lint" secrets={[]}>{`bash scripts/ci/cloud.sh rust-lint`}</Task>
      <Task id="third-party-notices" secrets={[]}>{`bash scripts/ci/cloud.sh third-party-notices`}</Task>
      <Task id="rust-test" secrets={[]}>{`bash scripts/ci/cloud.sh rust-test`}</Task>
      <Task id="wasm-build-script" secrets={[]}>{`bash scripts/ci/cloud.sh wasm-build-script`}</Task>
      <Task id="faults" secrets={[]}>{`bash scripts/ci/cloud.sh faults`}</Task>
      <Task id="web-bundle" secrets={[]}>{`bash scripts/ci/cloud.sh web-bundle`}</Task>
      <Task id="packages" secrets={[]}>{`bash scripts/ci/cloud.sh packages`}</Task>
      <Task id="cloud-contract" secrets={[]}>{`bash scripts/ci/cloud.sh cloud-contract`}</Task>
    </Parallel>
  </Workflow>
);
