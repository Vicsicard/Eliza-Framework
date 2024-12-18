{
  description = "Eliza Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pnpm2nix = {
      url = "github:nzbr/pnpm2nix-nzbr";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    pnpm2nix,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

    # Read and parse package.json
    packageJson = builtins.fromJSON (builtins.readFile ./package.json);

    # Extract versions
    nodeVersion = builtins.replaceStrings ["^" "~"] ["" ""] packageJson.engines.node;
    pnpmVersion = builtins.head (builtins.match "pnpm@([0-9.]+).*" packageJson.packageManager);

    # Function to fetch Node.js for a specific system
    fetchNodejs = system: let
      pkgs = nixpkgs.legacyPackages.${system};
      platformMap = {
        "x86_64-linux" = "linux-x64";
        "aarch64-linux" = "linux-arm64";
        "x86_64-darwin" = "darwin-x64";
        "aarch64-darwin" = "darwin-arm64";
      };
      platform = platformMap.${system};
    in
      pkgs.fetchurl {
        url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-${platform}.tar.xz";
        # Let Nix calculate the hash on first run
        hash = null;
      };

    # Create pkgs with overlays
    pkgsFor = system: let
      pkgs = nixpkgs.legacyPackages.${system};
      nodejsCustom = pkgs.stdenv.mkDerivation {
        pname = "nodejs";
        version = nodeVersion;

        src = fetchNodejs system;

        # Skip phases that aren't needed for pre-built binaries
        dontBuild = true;
        dontConfigure = true;
        dontPatchELF = true;
        dontPatchShebangs = true;

        installPhase = ''
          runHook preInstall

          mkdir -p $out
          cp -R * $out/

          mkdir -p $out/bin
          chmod +x $out/bin/*

          runHook postInstall
        '';

        # Skip unnecessary fixup steps
        dontFixup = true;

        # Add standard C libraries to rpath for binary compatibility
        nativeBuildInputs = with pkgs; [autoPatchelfHook];
        buildInputs = with pkgs; [stdenv.cc.cc.lib];
      };

      # Create a pnpm package directly from npm registry
      pnpmTarball = pkgs.fetchurl {
        url = "https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz";
        hash = null; # Will fail with correct hash on first run
      };
    in
      import nixpkgs {
        inherit system;
        overlays = [
          (final: prev: {
            nodejs = nodejsCustom;
            pnpm = prev.stdenv.mkDerivation {
              pname = "pnpm";
              version = pnpmVersion;

              src = pnpmTarball;

              nativeBuildInputs = with pkgs; [
                nodejsCustom
                makeWrapper
              ];

              installPhase = ''
                export HOME=$TMPDIR
                mkdir -p $out/bin $out/lib/node_modules/pnpm
                tar -xzf $src -C $out/lib/node_modules/pnpm --strip-components=1
                makeWrapper ${nodejsCustom}/bin/node $out/bin/pnpm \
                  --add-flags $out/lib/node_modules/pnpm/bin/pnpm.cjs
              '';
            };
          })
        ];
      };
  in {
    packages = forAllSystems (system: {
      default = pnpm2nix.lib.${system}.mkPnpmPackage {
        src = ./.;
        nodejs = (pkgsFor system).nodejs;
        installInPlace = true;

        installEnv = {
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
        };

        script = "build";

        extraBuildInputs = with (pkgsFor system); [
          python3
          pkg-config
          turbo
        ];
      };
    });

    devShells = forAllSystems (
      system: let
        pkgs = pkgsFor system;
      in {
        default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            pnpm
            python3
            pkg-config

            # Add canvas build dependencies
            cairo
            pango
            libpng
            libjpeg
            giflib
            librsvg
            pixman

            # Build essentials
            gcc
            gnumake

            # Optional but helpful
            vips
          ];

          # Network access
          __noChroot = true;
          __impureHostDeps = ["/etc/resolv.conf"];

          # Add pkg-config path
          shellHook = ''
            export PKG_CONFIG_PATH="${pkgs.cairo}/lib/pkgconfig:${pkgs.pango}/lib/pkgconfig:${pkgs.libpng}/lib/pkgconfig:$PKG_CONFIG_PATH"
            echo "Entering Eliza development environment with:"
            echo "Node.js $(node --version)"
            echo "pnpm $(pnpm --version)"
          '';
        };
      }
    );
  };
}
