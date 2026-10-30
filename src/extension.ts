import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { workspace, ExtensionContext, commands, extensions, tests, window, OutputChannel, env, WorkspaceEdit as VSWorkspaceEdit, Uri, Range as VSRange, Position as VSPosition, CancellationToken, DeclarationCoverage, FileCoverage, FileCoverageDetail, StatementCoverage, TestController, TestCoverageCount, TestRunProfile, TestRunProfileKind, TestRunRequest } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, State, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let clientStart: Promise<void> | undefined;
let lifecycle: Promise<void> = Promise.resolve();
let outputChannel: OutputChannel;

/** The test controller that shows the coverage report. Created once the server offers coverage. */
let coverageController: TestController | undefined;
let coverageProfile: TestRunProfile | undefined;
let coverageQueue: Promise<void> = Promise.resolve();
/** What the last coverage run showed, so unchanged reports don't start new runs. */
let shownCoverage: { key: string; files: Set<string> } | undefined;
/** Whether new reports replace what the Test Coverage view shows without being asked. */
let coverageFollowsReports = true;

export function activate(context: ExtensionContext) {
  outputChannel = window.createOutputChannel("Tusk PHP LSP");
  context.subscriptions.push(outputChannel);
  const config = workspace.getConfiguration("tuskPhpLsp");
  if (!config.get<boolean>("enable", true)) return;
  void maybeShowReleaseNotes(context);
  void runTransition(async () => {
    await startServer(context);
  });
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.restart", () => restartServer(context)));
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.reindex", () => { client?.sendNotification("tuskPhpLsp/reindex"); window.showInformationMessage("Tusk PHP LSP: Re-indexing..."); }));
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.showCoverage", () => refreshCoverage(context, true)));

  // PHPUnit's extension shows coverage from its own runs. Replacing that with ours
  // unasked would lose its results, so with it installed we wait for the command.
  coverageFollowsReports = !extensions.getExtension(PHPUNIT_EXTENSION_ID);

  // A saved file no longer matches the report's line numbers, so stop showing it.
  context.subscriptions.push(workspace.onDidSaveTextDocument((doc) => {
    if (shownCoverage?.files.has(doc.uri.toString())) void refreshCoverage(context, false);
  }));

  // Auto-update namespace when a PHP file is moved/renamed in the file explorer
  context.subscriptions.push(workspace.onDidRenameFiles(async (e) => {
    if (!client) return;
    for (const { oldUri, newUri } of e.files) {
      if (!oldUri.fsPath.endsWith(".php") || !newUri.fsPath.endsWith(".php")) continue;
      try {
        // Check if the file has a namespace declaration
        const doc = await workspace.openTextDocument(newUri);
        const text = doc.getText();
        if (!/^\s*namespace\s+/m.test(text)) continue;

        // Ask the server what namespace the new path should have
        const expectedNs = await client.sendRequest<string>(
          "workspace/executeCommand",
          { command: "tuskPhpLsp.namespaceForPath", arguments: [newUri.toString()] }
        );
        if (!expectedNs) continue;

        // Get the current namespace from the file
        const nsMatch = text.match(/^\s*namespace\s+([^;{]+)/m);
        const currentNs = nsMatch?.[1]?.trim();
        if (!currentNs || currentNs === expectedNs) continue;

        const action = await window.showInformationMessage(
          `Update namespace to "${expectedNs}"?`,
          "Update",
          "Skip"
        );
        if (action !== "Update") continue;

        await executeMoveToNamespace(newUri.toString(), expectedNs);
      } catch (err) {
        outputChannel.appendLine(`Auto-namespace error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }));
}

const PHPUNIT_EXTENSION_ID = "recca0120.vscode-phpunit";

type CoverageFileSummary = { uri: string; stale: boolean; coveredLines: number; executableLines: number; coveredMethods: number; methods: number };
type CoverageReport = { path: string; generated: string; files: CoverageFileSummary[] };
type ServerFileCoverage = {
  uri: string;
  stale: boolean;
  lines: Array<{ line: number; hits: number }>;
  methods: Array<{ name: string; line: number; endLine: number; hits: number }>;
};

function serverOffersCoverage(current: LanguageClient): boolean {
  const experimental = current.initializeResult?.capabilities.experimental as { tuskCoverage?: boolean } | undefined;
  return experimental?.tuskCoverage === true;
}

/** Create the coverage test controller the first time it's needed. VS Code shows the Testing view for any controller, so servers without coverage must not get one. */
function ensureCoverageController(context: ExtensionContext): TestRunProfile {
  if (coverageController && coverageProfile) return coverageProfile;
  coverageController = tests.createTestController("tuskPhpCoverage", "Tusk PHP Coverage");
  context.subscriptions.push(coverageController);
  coverageProfile = coverageController.createRunProfile(
    "Show Coverage Report",
    TestRunProfileKind.Coverage,
    () => refreshCoverage(context, true),
    false
  );
  coverageProfile.loadDetailedCoverage = (_run, fileCoverage, token) => loadFileCoverage(context, fileCoverage, token);
  return coverageProfile;
}

/** Load the current report into VS Code's coverage UI, one load at a time. */
function refreshCoverage(context: ExtensionContext, fromUser: boolean): Promise<void> {
  coverageQueue = coverageQueue
    .catch(() => undefined)
    .then(() => showCoverage(context, fromUser))
    .catch((err) => {
      outputChannel.appendLine(`Coverage error: ${formatError(err)}`);
      if (fromUser) window.showErrorMessage(`Tusk PHP: could not load coverage: ${formatError(err)}`);
    });
  return coverageQueue;
}

async function showCoverage(context: ExtensionContext, fromUser: boolean): Promise<void> {
  if (fromUser) coverageFollowsReports = true;
  if (!coverageFollowsReports) return;
  const current = client;
  if (!current || !serverOffersCoverage(current)) {
    if (fromUser) window.showWarningMessage("Tusk PHP: the running language server doesn't support test coverage yet.");
    return;
  }

  const report = await current.sendRequest<CoverageReport | null>("tusk/coverageReport");
  if (!report) {
    outputChannel.appendLine("Coverage: no report found");
    if (fromUser) window.showWarningMessage("Tusk PHP: no coverage report found. Run your tests with --coverage-clover clover.xml, or set tuskPhpLsp.coverage.reportPath. Tusk PHP never runs your tests.");
    if (!shownCoverage) return;
    // The report is gone. A run with no coverage makes VS Code stop showing the old one.
    shownCoverage = undefined;
    const emptyRun = coverageController?.createTestRun(new TestRunRequest(undefined, undefined, ensureCoverageController(context)), "Coverage report removed", false);
    emptyRun?.end();
    return;
  }

  // A stale file's line numbers may not match the report, so it's left out rather
  // than painted onto the wrong lines. Files with no executable lines have nothing to show.
  const shown = report.files.filter((f) => !f.stale && f.executableLines > 0);
  const stale = report.files.filter((f) => f.stale);
  const key = [report.path, report.generated, ...shown.map((f) => f.uri)].join("\n");
  if (!fromUser && shownCoverage?.key === key) return;

  const profile = ensureCoverageController(context);
  const run = coverageController!.createTestRun(new TestRunRequest(undefined, undefined, profile), "Coverage report", false);
  const summary = `Coverage from ${report.path}, written ${new Date(report.generated).toLocaleString()}: ${shown.length} file(s) shown, ${stale.length} hidden because they changed since then.`;
  run.appendOutput(`${summary}\r\n`);
  for (const f of stale) run.appendOutput(`Changed since the report: ${Uri.parse(f.uri).fsPath}\r\n`);
  outputChannel.appendLine(summary);
  for (const f of shown) {
    run.addCoverage(new FileCoverage(
      Uri.parse(f.uri),
      new TestCoverageCount(f.coveredLines, f.executableLines),
      undefined,
      f.methods > 0 ? new TestCoverageCount(f.coveredMethods, f.methods) : undefined
    ));
  }
  run.end();
  shownCoverage = { key, files: new Set(shown.map((f) => Uri.parse(f.uri).toString())) };
  if (fromUser) {
    const hidden = stale.length > 0 ? ` ${stale.length} changed since then and are hidden until you re-run your tests.` : "";
    window.showInformationMessage(`Tusk PHP: showing coverage for ${shown.length} file(s) from ${path.basename(report.path)}.${hidden}`);
  }
}

/** Line and method details for a file in the coverage UI. Empty means unknown, never untested. */
async function loadFileCoverage(context: ExtensionContext, fileCoverage: FileCoverage, token: CancellationToken): Promise<FileCoverageDetail[]> {
  const current = client;
  if (!current) return [];
  const uri = fileCoverage.uri.toString();
  // Unsaved edits may have moved lines, and the server only knows the file on disk.
  if (workspace.textDocuments.some((d) => d.uri.toString() === uri && d.isDirty)) return [];
  let result: ServerFileCoverage | null;
  try {
    result = await current.sendRequest<ServerFileCoverage | null>("tusk/fileCoverage", { textDocument: { uri } }, token);
  } catch (err) {
    outputChannel.appendLine(`Coverage error for ${uri}: ${formatError(err)}`);
    return [];
  }
  if (!result || result.stale) {
    // It changed outside the editor, such as a branch switch. Drop it from the list too.
    void refreshCoverage(context, false);
    return [];
  }
  return [
    ...result.lines.map((l) => new StatementCoverage(l.hits, new VSPosition(l.line, 0))),
    ...result.methods.map((m) => new DeclarationCoverage(m.name, m.hits, new VSRange(m.line, 0, m.endLine + 1, 0))),
  ];
}

/** globalState key holding the last extension version the user was shown release notes for. */
const RELEASE_NOTES_KEY = "tuskPhpLsp.lastSeenVersion";

/**
 * Show a one-time "what's new" prompt after the extension is upgraded. On a version
 * change we surface an info message linking to the bundled CHANGELOG.md (which itself
 * links to the language-server changelog). First installs stay quiet — we only record
 * the version so the next upgrade prompts once. VS Code only; Zed has no equivalent.
 */
async function maybeShowReleaseNotes(context: ExtensionContext): Promise<void> {
  try {
    const current = (context.extension.packageJSON as { version?: string })?.version;
    if (!current) return;
    const previous = context.globalState.get<string>(RELEASE_NOTES_KEY);
    // Record the current version up front so we prompt at most once per upgrade,
    // even if the user dismisses the message.
    await context.globalState.update(RELEASE_NOTES_KEY, current);
    // First install (nothing recorded) or no change: don't nag.
    if (!previous || previous === current) return;
    const action = await window.showInformationMessage(
      `Tusk PHP updated to ${current}.`,
      "See what's new"
    );
    if (action === "See what's new") {
      // vsce lowercases the file's name in the package; a dev checkout keeps it as is.
      const name = ["changelog.md", "CHANGELOG.md"].find((n) => fs.existsSync(path.join(context.extensionPath, n)));
      if (name) {
        await commands.executeCommand("markdown.showPreview", Uri.file(path.join(context.extensionPath, name)));
      }
    }
  } catch (err) {
    outputChannel.appendLine(`Release-notes check failed: ${formatError(err)}`);
  }
}

/** Send moveToNamespace to the server and apply the returned WorkspaceEdit. */
async function executeMoveToNamespace(uri: string, targetNS: string): Promise<boolean> {
  if (!client) return false;
  type ServerEdit = { changes?: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> };
  const result = await client.sendRequest<ServerEdit>(
    "workspace/executeCommand",
    { command: "tuskPhpLsp.moveToNamespace", arguments: [uri, targetNS] }
  );
  if (!result?.changes) return false;
  const wsEdit = new VSWorkspaceEdit();
  for (const [fileUri, edits] of Object.entries(result.changes)) {
    for (const edit of edits) {
      wsEdit.replace(
        Uri.parse(fileUri),
        new VSRange(
          new VSPosition(edit.range.start.line, edit.range.start.character),
          new VSPosition(edit.range.end.line, edit.range.end.character)
        ),
        edit.newText
      );
    }
  }
  return workspace.applyEdit(wsEdit);
}

/** Read tusk-lsp.json pin info; returns undefined if unreadable. */
function readLspPin(context: ExtensionContext): { version: string; sha256: Record<string, string> } | undefined {
  try {
    const raw = fs.readFileSync(path.join(context.extensionPath, "tusk-lsp.json"), "utf8");
    const json = JSON.parse(raw) as { lsp?: { version?: string; sha256?: Record<string, string> } };
    const lsp = json?.lsp;
    if (lsp?.version && lsp?.sha256) {
      return { version: lsp.version, sha256: lsp.sha256 };
    }
  } catch {
    outputChannel.appendLine("Tusk PHP: could not read tusk-lsp.json — skipping version check and download");
  }
  return undefined;
}

/** Run a binary with --version and return trimmed stdout, or undefined on failure. */
function getBinaryVersion(binaryPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binaryPath, ["--version"], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Download a URL to destPath, following up to maxRedirects redirects. Returns the SHA-256 hex digest. */
function downloadFile(url: string, destPath: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl: string, hopsLeft: number) => {
      https.get(currentUrl, (res) => {
        const { statusCode, headers } = res;

        if (statusCode !== undefined && [301, 302, 303, 307, 308].includes(statusCode)) {
          if (hopsLeft <= 0) {
            res.destroy();
            reject(new Error(`Too many redirects downloading ${url}`));
            return;
          }
          const location = headers["location"];
          if (!location) {
            res.destroy();
            reject(new Error(`Redirect with no location header from ${currentUrl}`));
            return;
          }
          res.destroy();
          attempt(location, hopsLeft - 1);
          return;
        }

        if (!statusCode || statusCode < 200 || statusCode >= 300) {
          res.destroy();
          // Clean up any partial file
          try { fs.unlinkSync(destPath); } catch {}
          reject(new Error(`HTTP ${statusCode ?? "unknown"} downloading ${url}`));
          return;
        }

        const hash = crypto.createHash("sha256");
        const out = fs.createWriteStream(destPath);

        // Pipe into both the hash stream and the file stream so every byte
        // written to disk is also hashed (Fix 3).
        res.pipe(hash, { end: false });
        res.pipe(out);

        // Resolve on "close" (fd fully flushed and closed) rather than
        // "finish" (merely flushed) to avoid races on subsequent chmod/exec
        // on Windows (Fix 4).
        out.on("close", () => {
          resolve(hash.digest("hex"));
        });

        out.on("error", (err) => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });

        res.on("error", (err) => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });
      }).on("error", (err) => {
        reject(err);
      });
    };

    attempt(url, maxRedirects);
  });
}

async function findServerBinary(context: ExtensionContext): Promise<string | undefined> {
  const platformMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  const goos = platformMap[process.platform] ?? process.platform;
  const goarch = archMap[process.arch] ?? process.arch;
  const ext = process.platform === "win32" ? ".exe" : "";
  const platformKey = `${goos}-${goarch}`;

  const pin = readLspPin(context);

  // Step 1: Configured override
  const configPath = workspace.getConfiguration("tuskPhpLsp").get<string>("executablePath", "");
  if (configPath) {
    if (fs.existsSync(configPath)) {
      outputChannel.appendLine(`Using configured binary: ${configPath}`);
      return configPath;
    }
    outputChannel.appendLine(`Configured binary not found: ${configPath} — falling back to bundled/cached/PATH`);
    // Fall through intentionally; do NOT exec a missing path
  }

  // Step 2: Bundled binary under extensionPath
  const bundled = path.join(context.extensionPath, "bin", platformKey, `tusk-php${ext}`);
  if (fs.existsSync(bundled)) {
    if (process.platform !== "win32") {
      try { fs.chmodSync(bundled, 0o755); } catch {}
    }
    if (pin) {
      const bundledVersion = await getBinaryVersion(bundled);
      if (bundledVersion !== undefined && bundledVersion.includes(pin.version)) {
        outputChannel.appendLine(`Using bundled binary (version ${pin.version}): ${bundled}`);
        return bundled;
      } else {
        outputChannel.appendLine(
          `Bundled binary version mismatch (got "${bundledVersion ?? "unknown"}", want "${pin.version}") — falling through to cache/download`
        );
        // Fall through to cached/download path
      }
    } else {
      outputChannel.appendLine(`Using bundled binary: ${bundled}`);
      return bundled;
    }
  }

  // Step 3: Cached download in global storage
  const cacheDir = path.join(context.globalStorageUri.fsPath, "bin", platformKey);
  const cachedBin = path.join(cacheDir, `tusk-php${ext}`);

  if (fs.existsSync(cachedBin)) {
    if (pin) {
      const versionOut = await getBinaryVersion(cachedBin);
      const versionMatches = versionOut !== undefined && versionOut.includes(pin.version);
      if (versionMatches) {
        outputChannel.appendLine(`Using cached binary (version ${pin.version}): ${cachedBin}`);
        return cachedBin;
      } else {
        outputChannel.appendLine(
          `Cached binary version mismatch (got "${versionOut ?? "unknown"}", want "${pin.version}") — re-downloading`
        );
        // Fall through to download
      }
    } else {
      // No pin available; use cache as-is
      outputChannel.appendLine(`Using cached binary (no pin available): ${cachedBin}`);
      return cachedBin;
    }
  }

  // Step 4: Download from GitHub releases
  if (pin) {
    const rawSum = pin.sha256[platformKey];
    if (!rawSum) {
      outputChannel.appendLine(`Tusk PHP: no SHA-256 pin for platform "${platformKey}" — skipping download`);
    } else {
      const expectedSum = rawSum.replace(/^sha256:/i, "").toLowerCase();
      const assetName = `tusk-php-${platformKey}${ext}`;
      const downloadUrl = `https://github.com/Tusk-PHP/lsp/releases/download/${pin.version}/${assetName}`;

      outputChannel.appendLine(`Downloading Tusk PHP LSP ${pin.version} for ${platformKey}…`);
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        const actualSum = await downloadFile(downloadUrl, cachedBin);

        if (actualSum.toLowerCase() !== expectedSum) {
          outputChannel.appendLine(
            `Tusk PHP: SHA-256 mismatch for downloaded binary (got ${actualSum}, expected ${expectedSum}) — discarding`
          );
          try { fs.unlinkSync(cachedBin); } catch {}
        } else {
          if (process.platform !== "win32") {
            try { fs.chmodSync(cachedBin, 0o755); } catch {}
          }
          outputChannel.appendLine(`Downloaded and verified binary: ${cachedBin}`);
          return cachedBin;
        }
      } catch (err) {
        outputChannel.appendLine(`Tusk PHP: download failed — ${formatError(err)}`);
        try { fs.unlinkSync(cachedBin); } catch {}
      }
    }
  }

  // Step 5: PATH fallback
  const pathBin = `tusk-php${ext}`;
  const versionOut = await getBinaryVersion(pathBin);
  if (versionOut !== undefined) {
    // Binary is on PATH
    if (pin && !versionOut.includes(pin.version)) {
      outputChannel.appendLine(
        `WARNING: tusk-php on PATH reports "${versionOut}" but pinned version is "${pin.version}" — version mismatch`
      );
      void window.showWarningMessage(
        `Tusk PHP: tusk-php on PATH is version "${versionOut}" but the extension expects "${pin.version}". ` +
        `Please update tusk-php to avoid compatibility issues.`
      );
    } else {
      outputChannel.appendLine(`Using tusk-php from PATH`);
    }
    return pathBin;
  }

  // Nothing resolved
  return undefined;
}

function runTransition(action: () => Promise<void>): Promise<void> {
  lifecycle = lifecycle.catch(() => undefined).then(action);
  return lifecycle.catch((err) => {
    outputChannel.appendLine(`Tusk PHP LSP lifecycle error: ${formatError(err)}`);
  });
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function startServer(context: ExtensionContext) {
  if (client) return;
  const serverPath = await findServerBinary(context);
  if (!serverPath) {
    window.showErrorMessage(
      "Tusk PHP: language server binary not found. Install `tusk-php` on your PATH, or set `tuskPhpLsp.executablePath`."
    );
    return;
  }
  const config = workspace.getConfiguration("tuskPhpLsp");
  const serverOptions: ServerOptions = { command: serverPath, args: ["--transport", "stdio"], transport: TransportKind.stdio };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "php" },
      // The pattern restriction is critical: without it every JSON file
      // in the workspace would route to our server.
      { scheme: "file", language: "json", pattern: "**/composer.json" },
    ],
    synchronize: { fileEvents: [workspace.createFileSystemWatcher("**/*.php"), workspace.createFileSystemWatcher("**/composer.json")] },
    outputChannel,
    initializationOptions: {
      phpVersion: config.get("phpVersion", "8.5"),
      framework: config.get("framework", "auto"),
      containerAware: config.get("containerAware", true),
      diagnosticsEnabled: config.get("diagnostics.enable", true),
      phpstanEnabled: config.get("diagnostics.phpstan.enable", true),
      phpstanPath: config.get("diagnostics.phpstan.path", ""),
      phpstanLevel: config.get("diagnostics.phpstan.level", ""),
      phpstanConfig: config.get("diagnostics.phpstan.configPath", ""),
      coverageReportPath: config.get("coverage.reportPath", ""),
      coverageNotifications: true,
      pintEnabled: config.get("diagnostics.pint.enable", true),
      pintPath: config.get("diagnostics.pint.path", ""),
      pintConfig: config.get("diagnostics.pint.configPath", ""),
      maxIndexFiles: config.get("maxIndexFiles", 10000),
      excludePaths: config.get("excludePaths", ["vendor", "node_modules", ".git"]),
      phpManualLocale: config.get("phpManual.locale", ""),
      phpManualOpenOnDefinition: config.get("phpManual.openOnDefinition", false),
      composer: {
        hover: {
          enable: config.get("composer.hover.enable", true),
        },
        openOnDefinition: config.get("composer.openOnDefinition", false),
      },
    },
    middleware: {
      executeCommand: async (command, args, next) => {
        if (command === "tuskPhpLsp.copyNamespace") {
          const uri = (args.length > 0 && typeof args[0] === "string") ? args[0] : window.activeTextEditor?.document.uri.toString();
          if (!uri) return;
          try {
            const ns = await next(command, [uri]) as string;
            if (ns) {
              await env.clipboard.writeText(ns);
              window.showInformationMessage(`Copied: ${ns}`);
            }
            return ns;
          } catch (err) {
            outputChannel.appendLine(`copyNamespace error: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        if (command === "tuskPhpLsp.moveToNamespace") {
          const uri = (args.length > 0 && typeof args[0] === "string") ? args[0] : window.activeTextEditor?.document.uri.toString();
          if (!uri) return;
          let currentNs = "";
          try {
            const fqn = await next("tuskPhpLsp.copyNamespace", [uri]) as string;
            if (fqn) {
              const sep = fqn.lastIndexOf("\\");
              currentNs = sep > 0 ? fqn.substring(0, sep) : fqn;
            }
          } catch { /* ignore */ }
          const targetNS = await window.showInputBox({
            prompt: "Enter the target namespace",
            value: currentNs,
            placeHolder: "App\\Domain\\Models",
            validateInput: (v) => v.trim() === "" ? "Namespace cannot be empty" : undefined,
          });
          if (!targetNS) return;
          try {
            const applied = await executeMoveToNamespace(uri, targetNS);
            if (applied) {
              window.showInformationMessage(`Moved to namespace ${targetNS}`);
            }
          } catch (err) {
            window.showErrorMessage(`Move to namespace failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        return next(command, args);
      },
    },
  };
  const nextClient = new LanguageClient("tuskPhpLsp", "Tusk PHP LSP", serverOptions, clientOptions);
  nextClient.onDidChangeState(({ oldState, newState }) => {
    outputChannel.appendLine(`Tusk PHP LSP state: ${State[oldState]} -> ${State[newState]}`);
  });
  nextClient.onNotification("tusk/coverageChanged", () => {
    void refreshCoverage(context, false);
  });
  client = nextClient;
  clientStart = Promise.resolve(nextClient.start())
    .then(() => {
      outputChannel.appendLine("Tusk PHP LSP server started");
    })
    .catch((err) => {
      if (client === nextClient) {
        client = undefined;
      }
      window.showErrorMessage(`Tusk PHP LSP failed: ${formatError(err)}`);
      throw err;
    })
    .finally(() => {
      if (client === nextClient) {
        clientStart = undefined;
      }
    });
  await clientStart;
}

async function restartServer(context: ExtensionContext) {
  await runTransition(async () => {
    await stopServer();
    await startServer(context);
    window.showInformationMessage("Tusk PHP LSP: Server restarted");
  });
}

async function stopServer() {
  const current = client;
  const startPromise = clientStart;
  if (!current) return;

  if (startPromise) {
    try {
      await startPromise;
    } catch {
      // The start attempt already failed; there is nothing left to stop cleanly.
    }
  }

  client = undefined;
  clientStart = undefined;

  try {
    if (current.state === State.Running) {
      await current.stop();
    }
  } catch (err) {
    outputChannel.appendLine(`Ignoring stop error: ${formatError(err)}`);
  }
}

export function deactivate(): Thenable<void> | undefined {
  return stopServer();
}
