{ writeScriptBin, bun }:
writeScriptBin "glueson" ''
  #!${bun}/bin/bun
  ${builtins.readFile ./index.ts}
''
