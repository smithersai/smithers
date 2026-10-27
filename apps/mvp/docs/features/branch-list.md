# Branches

`/$owner/$repo/branches` lists the same visible refs as the repository picker. Each name opens its tree, and the default branch is marked. Loading, failed reads, empty lists and truncated lists remain distinct.

This is repository-browser infrastructure using the existing durable repository read path and public `@smthrs/ui` primitives from the library catalog. It adds no write, retry loop or alternate source of branch visibility. The repository header holds the page's only bell.

`e2e/branches-list.spec.ts` opens the direct URL and follows main. `attention/detail.test.ts` verifies that the header's bell does not get a duplicate floating bell.
