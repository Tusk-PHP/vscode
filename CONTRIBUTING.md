# Contributing to the Tusk PHP VS Code extension

This repository is the **VS Code client** for [Tusk PHP](https://github.com/Tusk-PHP/lsp),
the language server (LSP). The client is a thin TypeScript extension that locates a
`tusk-php` server binary, launches it over stdio, and wires up VS Code-specific glue
(namespace commands, auto-rename, settings). Almost all language intelligence lives in
the [`Tusk-PHP/lsp`](https://github.com/Tusk-PHP/lsp) repo — when you're debugging a
diagnostic, completion, or hover, that's usually where the change belongs.

## Prerequisites

- [Bun](https://bun.sh) (used for install, type-checking, bundling, and packaging)
- VS Code `^1.88.0`
- A `tusk-php` server binary — either the pinned release (auto-downloaded) or a local
  build of the LSP (see [Pairing with a local tusk-php](#pairing-with-a-local-tusk-php))

## Getting started

```bash
bun install
bun run compile   # tsc -p ./ --noEmit  (type-check only, no output)
bun run bundle    # esbuild  → out/extension.js
```

The extension is **bundled with esbuild**, not emitted file-by-file by `tsc`:

- `bun run compile` only **type-checks** (`--noEmit`) — it's the correctness gate and
  emits nothing.
- `bun run bundle` produces the runnable `out/extension.js`.
- `bun run watch` runs esbuild in incremental `--watch` mode while you edit
  `src/extension.ts`.
- `bun run package` bundles with `--minify` before calling `vsce` (see
  [Packaging](#packaging-a-vsix)).

## Running the extension locally

The extension is launched in an **Extension Development Host** — a second VS Code window
with your in-development build loaded.

1. Create `.vscode/launch.json` (it is not committed):

   ```jsonc
   {
     "version": "0.2.0",
     "configurations": [
       {
         "name": "Run Extension",
         "type": "extensionHost",
         "request": "launch",
         "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
         "outFiles": ["${workspaceFolder}/out/**/*.js"],
         "preLaunchTask": "${defaultBuildTask}"
       }
     ]
   }
   ```

2. Run `bun run bundle` (or have `bun run watch` going so `out/extension.js` stays
   current), then press **F5**. `bun run compile` alone won't work for F5 — it only
   type-checks and emits nothing.
3. In the new window, open a PHP project (one with a `composer.json`). The extension
   activates on `onLanguage:php` or `workspaceContains:**/composer.json`.
4. Watch **Output → "Tusk PHP LSP"** — the channel logs exactly which binary was
   resolved and why. This is your primary debugging tool for binary-resolution and
   server-lifecycle issues.

Useful commands (Command Palette) while testing:

- **Tusk PHP: Restart Server** — reloads the server without restarting the host
- **Tusk PHP: Re-index Workspace**
- **Tusk PHP: Copy Namespace** / **Move to Namespace…**

### How the server binary is resolved

`findServerBinary` in `src/extension.ts` tries these in order and logs each step:

1. **`tuskPhpLsp.executablePath`** setting, if it points at an existing file. This wins
   unconditionally and skips the version check — it's the hook for local LSP development.
2. **Bundled** binary at `bin/<os>-<arch>/tusk-php`. Present only in packaged releases;
   verified to match the version pinned in `tusk-lsp.json`.
3. **Cached** download in the extension's global storage (also version-checked).
4. **Download** of the pinned release from `Tusk-PHP/lsp`, verified against the SHA-256
   sums in `tusk-lsp.json`, then cached.
5. **`tusk-php` on `PATH`** as a last resort (warns on a version mismatch).

`<os>` is `darwin` / `linux` / `windows`; `<arch>` is `amd64` / `arm64`.

## Pairing with a local tusk-php (LSP) checkout

When you're developing the extension and the server together, point the client at your
local server build instead of the pinned release.

1. Clone and build the server:

   ```bash
   git clone https://github.com/Tusk-PHP/lsp.git tusk-php-lsp
   cd tusk-php-lsp
   # Build the server binary (see that repo's README for the exact command);
   # it produces a `tusk-php` executable.
   go build -o tusk-php .
   ```

2. Point the extension at it. Either set the absolute path in your **dev** workspace's
   settings:

   ```jsonc
   // .vscode/settings.json in the PHP project you open in the dev host
   {
     "tuskPhpLsp.executablePath": "/absolute/path/to/tusk-php-lsp/tusk-php"
   }
   ```

   …or put your build on `PATH` so step 5 of resolution finds it.

3. Press **F5**, open a PHP project, and confirm the Output channel logs
   `Using configured binary: …` (or `Using tusk-php from PATH`).

4. After rebuilding the server, run **Tusk PHP: Restart Server** to pick up the new
   binary — no need to relaunch the dev host.

Notes:

- `executablePath` **bypasses the version pin**, so a locally built server whose
  `--version` doesn't match `tusk-lsp.json` is used as-is. That's intentional for
  development; just be aware the pinned release is what ships.
- The client talks to the server over **stdio** (`--transport stdio`). If the server
  fails to start, the Output channel and the host's Developer Tools console
  (`Help → Toggle Developer Tools`) carry the error.
- Server-side settings are passed via `initializationOptions` in
  `startServer`. When you add a new client setting, declare it under
  `contributes.configuration` in `package.json` *and* forward it in
  `initializationOptions` for the server to receive it.

## Packaging a .vsix

```bash
bun run package   # esbuild --minify  +  bun x @vscode/vsce package  →  tusk-php-<version>.vsix
```

This bundles `src/` into a minified `out/extension.js` and packages a `.vsix` **without**
bundled server binaries — useful as a build smoke test and for installing locally via
**Extensions → Install from VSIX…**. `src/`, `.claude/`, `docs/`, `CLAUDE.md`, and
`CONTRIBUTING.md` are excluded via `.vscodeignore`. The real, binary-bundled artifact is
produced only by the release workflow.

## Releases

Releases are tag-driven and handled by `.github/workflows/release.yml`:

1. Bump `version` in `package.json` and, when targeting a new server, the `lsp.version`
   and `lsp.sha256` sums in `tusk-lsp.json`. **Bump the LSP pin deliberately, after
   compatibility testing** — the sums must match the upstream release's checksums or the
   release aborts (verification is fail-closed).
2. Tag and push. The workflow downloads and verifies the pinned binaries into
   `bin/<os>-<arch>/`, packages the `.vsix`, and publishes to the VS Marketplace and
   Open VSX (requires `VSCE_PAT` / `OVSX_PAT` secrets).

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on PRs: `bun install`,
`bun run compile` (type-check), then a `bun run package` smoke test (no bundled binaries).
Make sure it type-checks cleanly before opening a PR.

## Changelogs

There are **two** changelogs, and which one you edit depends on what changed:

- **This repo's [`CHANGELOG.md`](./CHANGELOG.md)** — short and **user-facing**, covering
  the extension itself: settings, commands, editor integration, and which language-server
  version each release bundles. VS Code renders it as the **Changelog** tab on the
  extension page, and the extension shows a one-time "what's new" prompt linking it after
  an update. It does *not* need to follow Keep a Changelog — write product-style entries
  for the person installing the extension.
- **The [LSP changelog](https://github.com/Tusk-PHP/lsp/blob/main/CHANGELOG.md)** — the
  detailed, technical source of truth for the language server (diagnostics, completions,
  framework intelligence). It follows Keep a Changelog.

Rules of thumb:

- An **extension change** (new setting/command, editor behavior, a fix in
  `src/extension.ts`) → add a bullet under `## [Unreleased]` in this repo's `CHANGELOG.md`.
- **Bumping the bundled server** (`tusk-lsp.json`) → add/extend the release's entry here
  with a line like *"Bundles Tusk PHP language server X.Y.Z"* and a **link** to the LSP
  changelog. Don't restate the server's notes — link them (this mirrors how
  [ruff-vscode](https://github.com/astral-sh/ruff-vscode/blob/main/CHANGELOG.md) handles
  its bundled binary).
- A **server-side change** you make in the LSP repo → record it in the LSP changelog, not
  here.
