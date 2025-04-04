{
  runCommand,
  nodejs,
  esbuild,
  stdenv,
  coreutils,
}:
stdenv.mkDerivation {
  name = "glueson";
  buildInputs = [
    esbuild
    coreutils
  ];

  src = ./src;

  installPhase = ''
    mkdir -p $out/bin
    echo "#!${nodejs}/bin/node" > $out/bin/glueson
    esbuild ./index.ts >> $out/bin/glueson
    chmod +x $out/bin/glueson
  '';
}
