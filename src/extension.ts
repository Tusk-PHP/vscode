import * as path from "path";
import * as fs from "fs";
import { workspace, ExtensionContext, commands, window, OutputChannel, env, WorkspaceEdit as VSWorkspaceEdit, Uri, Range as VSRange, Position as VSPosition } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, State, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let clientStart: Promise<void> | undefined;
let lifecycle: Promise<void> = Promise.resolve();
let outputChannel: OutputChannel;

export function activate(context: ExtensionContext) {
  outputChannel = window.createOutputChannel("Tusk PHP LSP");
  context.subscriptions.push(outputChannel);
  const config = workspace.getConfiguration("tuskPhpLsp");
  if (!config.get<boolean>("enable", true)) return;
  void runTransition(async () => {
    await startServer(context);
  });
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.restart", () => restartServer(context)));
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.reindex", () => { client?.sendNotification("tuskPhpLsp/reindex"); window.showInformationMessage("Tusk PHP LSP: Re-indexing..."); }));

  // Copy Namespace — copies FQN to clipboard
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.copyNamespace", async (...args: unknown[]) => {
    if (!client) return;
    const uri = (args.length > 0 && typeof args[0] === "string") ? args[0] : window.activeTextEditor?.document.uri.toString();
    if (!uri) return;
    try {
      const ns = await client.sendRequest<string>("workspace/executeCommand", { command: "tuskPhpLsp.copyNamespace", arguments: [uri] });
      if (ns) {
        await env.clipboard.writeText(ns);
        window.showInformationMessage(`Copied: ${ns}`);
      }
    } catch (err) {
      outputChannel.appendLine(`copyNamespace error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  // Move to Namespace — prompts for target, sends to server
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.moveToNamespace", async (...args: unknown[]) => {
    if (!client) return;
    const uri = (args.length > 0 && typeof args[0] === "string") ? args[0] : window.activeTextEditor?.document.uri.toString();
    if (!uri) return;

    // Pre-fill with current namespace
    let currentNs = "";
    try {
      const fqn = await client.sendRequest<string>("workspace/executeCommand", { command: "tuskPhpLsp.copyNamespace", arguments: [uri] });
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

function findServerBinary(context: ExtensionContext): string {
  const configPath = workspace.getConfiguration("tuskPhpLsp").get<string>("executablePath", "");
  if (configPath) {
    if (fs.existsSync(configPath)) {
      outputChannel.appendLine(`Using configured binary: ${configPath}`);
      return configPath;
    }
    outputChannel.appendLine(`Configured binary not found: ${configPath}`);
  }
  const platformMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  const goos = platformMap[process.platform] ?? process.platform;
  const goarch = archMap[process.arch] ?? process.arch;
  const ext = process.platform === "win32" ? ".exe" : "";
  const bundled = path.join(context.extensionPath, "bin", `${goos}-${goarch}`, `php-lsp${ext}`);
  if (fs.existsSync(bundled)) {
    outputChannel.appendLine(`Using bundled binary: ${bundled}`);
    return bundled;
  }
  outputChannel.appendLine(`Falling back to PATH: php-lsp`);
  return "php-lsp";
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
  const serverPath = findServerBinary(context);
  const config = workspace.getConfiguration("tuskPhpLsp");
  const serverOptions: ServerOptions = { command: serverPath, args: ["--transport", "stdio"], transport: TransportKind.stdio };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "php" }],
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
      pintEnabled: config.get("diagnostics.pint.enable", true),
      pintPath: config.get("diagnostics.pint.path", ""),
      pintConfig: config.get("diagnostics.pint.configPath", ""),
      maxIndexFiles: config.get("maxIndexFiles", 10000),
      excludePaths: config.get("excludePaths", ["vendor", "node_modules", ".git"]),
    },
  };
  const nextClient = new LanguageClient("tuskPhpLsp", "Tusk PHP LSP", serverOptions, clientOptions);
  nextClient.onDidChangeState(({ oldState, newState }) => {
    outputChannel.appendLine(`Tusk PHP LSP state: ${State[oldState]} -> ${State[newState]}`);
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
