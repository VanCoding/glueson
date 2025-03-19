{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };
  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      flake.overlays.default = prev: final: {
        glueson = prev.callPackage ./glueson.nix { };
        writeGluesonApplication =
          { name, value }:
          prev.writeScriptBin name ''
            #!${final.glueson}/bin/glueson
            ${builtins.toJSON value}
          '';
      };
      perSystem =
        { pkgs, config, ... }:
        {
          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.nixfmt-rfc-style
              pkgs.bun
              pkgs.nodejs_20
              config.packages.glueson
            ];
          };
          packages.glueson = pkgs.callPackage ./glueson.nix { };
        };
    };
}
