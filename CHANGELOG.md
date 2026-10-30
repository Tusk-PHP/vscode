# Changelog

User-facing changes to the **Tusk PHP** VS Code extension — the editor integration
itself (settings, commands, binary handling) and which **Tusk PHP language server**
version each release bundles.

For the language server's own changes — diagnostics, completions, hover, and Laravel /
Symfony intelligence — see the
[Tusk PHP LSP changelog](https://github.com/Tusk-PHP/lsp/blob/main/CHANGELOG.md). Each
release below links the server notes for the version it ships.

This changelog is written for people installing the extension; it does not follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) strictly. The format is based on
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- Show a one-time **"what's new"** prompt after the extension updates, linking to this
  changelog (VS Code only).

## [0.9.0] - 2026-06-22

Bundles **Tusk PHP language server 0.9.0** —
[what's new in the server](https://github.com/Tusk-PHP/lsp/releases/tag/0.9.0).

- **Namespace commands** — *Copy Namespace* and *Move to Namespace…*, plus an automatic
  prompt to update a file's namespace when you move or rename it in the explorer.
- **`composer.json` intelligence** — hover cards on `require` / `require-dev` packages,
  with an option to open a package's Packagist page on Cmd+Click.
- **php.net manual links** — hover on built-in PHP symbols links to the manual, with a
  configurable locale and an option to open the page on Cmd+Click.
- **PHPStan & Laravel Pint diagnostics** on save, auto-detecting `vendor/bin` binaries
  with overrides for paths, config files, and PHPStan level.
- **Zero-setup server** — the matching language-server binary is downloaded and verified
  automatically; set `tuskPhpLsp.executablePath` to use your own build, or rely on one
  found on your `PATH`.
- Reliable startup over **Remote-SSH** and on Windows, with checksum-verified binary
  downloads.
