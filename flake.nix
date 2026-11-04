{
  description = "maintain-plugins dev shell (bun, node, uv; `.#e2e` adds pinned Pi/OMP CLIs)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Host CLIs the e2e suite spawns. Single source of truth for the pins:
      # CI uses this shell, and .agents/skills/host-version/scripts/check-host-versions.sh
      # greps these exact `name@version` strings.
      hostCLIs = [
        "@earendil-works/pi-coding-agent@1.5.0"
        "@oh-my-pi/pi-coding-agent@18.16.0"
      ];
    in
    {
      # shortcut: bun and node follow the nixpkgs revision in flake.lock, so `nix flake update`
      # can move bun off the old CI pin (1.4.2); check `bun --version` after updating. Upgrade to
      # an explicit override (as in system-prompt-switch) if a bun version must be held or is
      # needed before nixpkgs has it.
      devShells = forAllSystems (pkgs: let
        packages = [ pkgs.bun pkgs.nodejs_26 pkgs.uv ];
      in {
        # Day-to-day development (direnv): no host CLIs installed.
        default = pkgs.mkShell { inherit packages; };

        # Tests / CI: `nix develop .#e2e`. Adds the pinned Pi/OMP CLIs.
        e2e = pkgs.mkShell {
          inherit packages;

          # Idempotent: installs the pinned CLIs into .direnv/host-cli once.
          shellHook = ''
            export HOST_CLI_PREFIX="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.direnv/host-cli"
            export PATH="$HOST_CLI_PREFIX/bin:$PATH"
            stamp="${builtins.concatStringsSep " " hostCLIs}"
            if [ "$(cat "$HOST_CLI_PREFIX/.stamp" 2>/dev/null)" != "$stamp" ]; then
              echo "Installing pinned Pi/OMP CLIs into .direnv/host-cli ..." >&2
              npm install -g --prefix "$HOST_CLI_PREFIX" ${builtins.concatStringsSep " " hostCLIs} >&2 \
                && echo "$stamp" > "$HOST_CLI_PREFIX/.stamp"
            fi
          '';
        };
      });
    };
}
