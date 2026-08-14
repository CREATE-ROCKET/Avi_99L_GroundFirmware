{
  description = "CREATE 99L Ground Station development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.appimage-run
          pkgs.electron
          pkgs.nodejs_22
          pkgs.socat
        ];

        ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin";
      };
    };
}
