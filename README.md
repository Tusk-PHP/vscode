# Tusk PHP — VS Code extension

VS Code extension for [Tusk PHP](https://github.com/Tusk-PHP/lsp), a PHP language
server with Laravel and Symfony awareness.

Available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=open-southeners.tusk-php)
and the [Open VSX Registry](https://open-vsx.org/extension/open-southeners/tusk-php).

## LSP version

This extension bundles a specific, tested `tusk-php` language server version —
see [`tusk-lsp.json`](./tusk-lsp.json). The release workflow downloads the
matching `tusk-php-<os>-<arch>` binaries from
[Tusk-PHP/lsp releases](https://github.com/Tusk-PHP/lsp/releases) into
`bin/<os>-<arch>/tusk-php` and verifies each against the declared SHA-256 sums.

## Development

```bash
bun install
bun run compile   # tsc -p ./
bun run package   # bun x @vscode/vsce package
```

## Releases

Tag the repo to trigger `.github/workflows/release.yml`, which downloads the
pinned LSP binaries, packages the `.vsix`, and publishes to the Marketplace and
Open VSX (requires `VSCE_PAT` / `OVSX_PAT` repository secrets).
