{
  # The toolchain `.smithers/WORKSPACE.ts` declares, as one Nix closure.
  #
  # The workspace exports it as `environment = S.Nix.Environment({ flake })`
  # and hands it to the Microsandbox sandbox declaration, so a sandboxed
  # session plants this flake in its microVM and runs every command under
  # `nix develop` of it. `nix develop` at the root enters the same shell on a
  # host. `scripts/check-toolchain-pins.mjs` asserts the pnpm and Node pins
  # below against the workspace declaration, so a pin here and a pin there
  # cannot drift apart silently.
  #
  # Rust comes from `rust-toolchain.toml` through rust-overlay, so the crates
  # build with the same channel, profile, components, and targets rustup would
  # install. `flake.lock` pins nixpkgs and the overlay; regenerate it with
  # `nix flake update` and rebuild the wasm artifact when the Rust channel
  # moves (see rust-toolchain.toml).
  description = "smithers toolchain";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, rust-overlay, ... }:
    let
      # nixpkgs dropped x86_64-darwin; the Linux systems are what a
      # Microsandbox microVM and the hosted runners are.
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; }));
      # pnpm at exactly the version `.smithers/WORKSPACE.ts` and package.json
      # `packageManager` declare. nixpkgs carries a moving pnpm; a build tool
      # that asserts an exact version needs the tarball npm publishes, not a
      # channel's latest.
      pnpmPinned = pkgs: pkgs.stdenvNoCC.mkDerivation rec {
        pname = "pnpm";
        version = "11.25.0";
        src = pkgs.fetchurl {
          url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
          hash = "sha256-M90HSPJ+eRbE8ci2lDRhmD40U7BrvaYxKmKAEwtIgeU=";
        };
        dontBuild = true;
        installPhase = ''
          mkdir -p $out/lib/pnpm $out/bin
          cp -r . $out/lib/pnpm
          chmod +x $out/lib/pnpm/bin/pnpm.cjs $out/lib/pnpm/bin/pnpx.cjs
          ln -s $out/lib/pnpm/bin/pnpm.cjs $out/bin/pnpm
          ln -s $out/lib/pnpm/bin/pnpx.cjs $out/bin/pnpx
        '';
      };
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_26
            (pnpmPinned pkgs)
            (assert pkgs.bun.version == "1.4.1"; pkgs.bun)
            (assert pkgs.jujutsu.version == "0.39.0"; pkgs.jujutsu)
            pkgs.ripgrep
            pkgs.git
            pkgs.cacert
            (pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml)
          ];
        };
      });
    };
}
