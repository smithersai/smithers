# smithers-ci

Fast CI for agents. Run it in a repository:

```sh
bunx smithers-ci
```

It reads the CI you have today, replays your recent commits in temporary copies, and prints how long each one took
your way and the Smithers way. It changes nothing in your repository.

```sh
bunx smithers-ci inventory   # Print what your CI runs.
bunx smithers-ci replay      # The replay alone.
bunx smithers-ci apply       # Write the faster CI into the repository.
```

`npx smithers-ci` works the same way. You need Git and Node.js 22.19 or newer.

Read the [documentation](https://github.com/smithersai/smithers/blob/main/packages/ci/docs/README.md).
