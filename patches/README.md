# Deployment tool compatibility with Effect rc.115

These exact-version patches adapt the repository's private deployment tools to
Effect `4.0.0-rc.115`. Alchemy and its Cloudflare runtime `2.0.0-beta.76`,
alongside their Distilled `1.0.0-rc.8`
dependencies still call the removed lowercase Config constructors. Alchemy also
uses the former Config effect mapper and lowercase CLI constructors.

The patches update those calls to the corresponding rc.115 APIs in both source
and emitted JavaScript. They do not change Effect, resource declarations,
credentials, provider endpoints or deployment behavior. The public `@smthrs/*`
tarballs do not depend on these deployment packages and do not require these
patches in consumer applications.

`package.json#patchedDependencies` is used by Bun;
`pnpm-workspace.yaml#patchedDependencies` is used by pnpm. Keep their exact
package versions and patch paths identical, and regenerate both lockfiles when
a patch changes. Frozen installation must apply the checked-in patch bytes.

Validate with the offline stack tests in
`apps/site/scripts/deployment.test.mjs`, the documentation checks, and both
package managers' frozen installs. These checks import and inspect stacks; they
do not deploy infrastructure. Remove each patch when upgrading to an upstream
version that uses the supported Effect APIs, and repeat these checks before
deploying with that version.
