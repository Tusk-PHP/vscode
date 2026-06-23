# CLAUDE.md

Agent instructions for the **Tusk PHP VS Code extension** repo. Read this before making
changes. For human-facing setup and local-testing steps, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## What this repo is

This is the **VS Code client** for Tusk PHP — a thin TypeScript extension that locates a
`tusk-php` language-server binary, launches it over stdio, and adds VS Code-specific glue.
The language intelligence (diagnostics, completions, hover, namespace resolution) lives in
the separate server repo: **[`Tusk-PHP/lsp`](https://github.com/Tusk-PHP/lsp)**.

> Before changing client behavior, decide whether the fix actually belongs in the server.
> A wrong diagnostic, a missing completion, or bad hover content is almost always an LSP
> change in `Tusk-PHP/lsp`, not here. This repo's job is transport, settings, lifecycle,
> and binary resolution.

## Layout

- `src/extension.ts` — the entire extension. Single file. Key functions:
  - `activate` — entry point; starts the server, registers commands and the file-rename
    auto-namespace handler.
  - `findServerBinary` — 5-step binary resolution (see below). Logs every decision.
  - `startServer` / `restartServer` / `stopServer` — server lifecycle, serialized through
    the `lifecycle` promise chain (`runTransition`). Don't call start/stop directly outside
    that chain — concurrent transitions will race.
  - `downloadFile` — streaming download with redirect handling and SHA-256 hashing.
  - The `middleware.executeCommand` block — client-side handling of `copyNamespace` and
    `moveToNamespace`.
- `package.json` — `contributes.configuration` (all `tuskPhpLsp.*` settings) and
  `contributes.commands`.
- `tusk-lsp.json` — pins the server `version` and per-platform `sha256` sums the client
  downloads and verifies. **Source of truth for which server version ships.**
- `CHANGELOG.md` — thin, user-facing extension changelog (see [Changelogs](#changelogs)).
- `out/` — esbuild bundle output (gitignored). `bin/` — bundled server binaries, present
  only in release packaging (gitignored).
- `.github/workflows/` — `ci.yml` (compile + package smoke test), `release.yml`
  (tag-driven, downloads/verifies binaries, publishes).

## Build & verify

```bash
bun install
bun run compile     # tsc -p ./ --noEmit ; type-check only — the gate, must pass
bun run bundle      # esbuild → out/extension.js (needed to run the extension)
```

- Toolchain is **Bun**, not npm/yarn. Use `bun run <script>` and `bun x <tool>`.
- The extension is **bundled with esbuild**. `bun run compile` only type-checks
  (`--noEmit`) — it emits nothing; `out/extension.js` comes from `bun run bundle` (or
  `bun run package`, which bundles with `--minify`). Don't expect `compile` to produce a
  runnable build.
- TypeScript is `strict`. There are no unit tests; `bun run compile` is the correctness
  gate. Always run it after editing `src/extension.ts`.
- To smoke-test packaging: `bun run package` (bundles, then produces a `.vsix` without
  bundled binaries).
- Real behavior is verified by launching the Extension Development Host (F5) — see
  CONTRIBUTING.md. You generally can't do that headlessly; describe the manual check
  instead of claiming it passes.

## Conventions

- Keep it a single-file extension unless there's a strong reason to split. Match the
  existing terse style: early returns, narrow `try/catch`, and **log to the
  `outputChannel`** rather than throwing for non-fatal issues.
- **Adding a setting** is a two-place change: declare it under
  `contributes.configuration` in `package.json`, then forward it to the server in
  `startServer`'s `initializationOptions`. A setting the server reads is useless if only
  one half is done.
- **Adding a command**: register it in `package.json` `contributes.commands` and in
  `activate` via `commands.registerCommand`. Commands that delegate to the server go
  through `client.sendRequest("workspace/executeCommand", …)` or the
  `middleware.executeCommand` hook.
- Preserve the binary-resolution order and its log lines — they are the main field-debugging
  signal. The order is: `executablePath` → bundled → cached → download → `PATH`.
  `executablePath` intentionally bypasses the version pin (it's the local-dev hook); the
  other paths are version-checked against `tusk-lsp.json`.
- Downloads are **fail-closed**: never use a downloaded/cached binary without verifying its
  SHA-256 against `tusk-lsp.json`. Don't weaken this.

## Bumping the bundled server version

Edit `tusk-lsp.json`: set `lsp.version` and replace every `lsp.sha256.<platform>` with the
real sums from that upstream `Tusk-PHP/lsp` release's checksums. Release tags on the server
repo have **no leading `v`**. The release workflow aborts if any sum is missing or `TODO`,
so fill all five platforms. Bump deliberately, after compatibility testing.

## Changelogs

Two changelogs exist; pick by **what changed**, not by which repo you're sitting in.

- **`CHANGELOG.md` in this repo** — short, **user-facing**, freeform (NOT Keep a
  Changelog). Covers the extension: settings, commands, editor behavior, and which server
  version each release bundles. VS Code shows it as the Changelog tab, and
  `maybeShowReleaseNotes` in `src/extension.ts` opens it on update. Write entries for
  someone installing the extension.
- **`../lsp/CHANGELOG.md`** (sibling LSP checkout; canonical
  <https://github.com/Tusk-PHP/lsp/blob/main/CHANGELOG.md>) — detailed, technical, follows
  Keep a Changelog. Source of truth for the language server.

Routing:

- Extension change here (new setting/command, editor behavior, fix in `src/extension.ts`)
  → bullet under `## [Unreleased]` in **this repo's** `CHANGELOG.md`.
- Bumping the bundled server (`tusk-lsp.json`) → in this repo's `CHANGELOG.md`, add/extend
  the release entry with *"Bundles Tusk PHP language server X.Y.Z"* and a **link** to the
  LSP changelog. **Do not restate the server's notes — link them** (the Ruff/ruff-vscode
  model). The detailed entries for those server changes live in the LSP repo.
- A change you make in the LSP repo itself → record it in `../lsp/CHANGELOG.md`.

**Cross-repo write — allowed and expected, but scoped.** If a single task spans both repos
(e.g. a server feature plus the extension wiring), update each repo's changelog for its own
half. Caveats:

- Only touch the LSP repo's `CHANGELOG.md` for this purpose — no other edits there unless
  separately asked.
- Changes in the two repos belong in separate commits/PRs; **don't** stage, commit, or push
  either repo unless asked.
- If `../lsp/CHANGELOG.md` isn't checked out as a sibling, don't go hunting — note in your
  summary that the server-side entry still needs adding there, with the exact bullet text.

## Don't

- Don't commit or push unless asked. If asked, branch first — don't commit to `main`.
- Don't commit `out/`, `bin/`, or `*.vsix`.
- Don't hand-edit anything under `node_modules/` or `out/`.
- Don't bump `tusk-lsp.json` sums to placeholder values — that breaks the release.
