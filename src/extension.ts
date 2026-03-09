import * as path from "path";
import * as fs from "fs";
import { workspace, ExtensionContext, commands, window, OutputChannel } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, State, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let clientStart: Promise<void> | undefined;
let lifecycle: Promise<void> = Promise.resolve();
let outputChannel: OutputChannel;

export function activate(context: ExtensionContext) {
  outputChannel = window.createOutputChannel("PHP LSP");
  context.subscriptions.push(outputChannel);
  const config = workspace.getConfiguration("phpLsp");
  if (!config.get<boolean>("enable", true)) return;
  void runTransition(async () => {
    await startServer(context);
  });
  context.subscriptions.push(commands.registerCommand("phpLsp.restart", () => restartServer(context)));
  context.subscriptions.push(commands.registerCommand("phpLsp.reindex", () => { client?.sendNotification("phpLsp/reindex"); window.showInformationMessage("PHP LSP: Re-indexing..."); }));
}

function findServerBinary(context: ExtensionContext): string {
  const configPath = workspace.getConfiguration("phpLsp").get<string>("executablePath", "");
  if (configPath && fs.existsSync(configPath)) return configPath;
  const platformMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  const goos = platformMap[process.platform] ?? process.platform;
  const goarch = archMap[process.arch] ?? process.arch;
  const ext = process.platform === "win32" ? ".exe" : "";
  const bundled = path.join(context.extensionPath, "bin", `${goos}-${goarch}`, `php-lsp${ext}`);
  if (fs.existsSync(bundled)) return bundled;
  return "php-lsp";
}

function runTransition(action: () => Promise<void>): Promise<void> {
  lifecycle = lifecycle.catch(() => undefined).then(action);
  return lifecycle.catch((err) => {
    outputChannel.appendLine(`PHP LSP lifecycle error: ${formatError(err)}`);
  });
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function startServer(context: ExtensionContext) {
  if (client) return;
  const serverPath = findServerBinary(context);
  const config = workspace.getConfiguration("phpLsp");
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
  const nextClient = new LanguageClient("phpLsp", "PHP LSP", serverOptions, clientOptions);
  nextClient.onDidChangeState(({ oldState, newState }) => {
    outputChannel.appendLine(`PHP LSP state: ${State[oldState]} -> ${State[newState]}`);
  });
  client = nextClient;
  clientStart = Promise.resolve(nextClient.start())
    .then(() => {
      outputChannel.appendLine("PHP LSP server started");
    })
    .catch((err) => {
      if (client === nextClient) {
        client = undefined;
      }
      window.showErrorMessage(`PHP LSP failed: ${formatError(err)}`);
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
    window.showInformationMessage("PHP LSP: Server restarted");
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
