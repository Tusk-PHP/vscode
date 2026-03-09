import * as path from "path";
import * as fs from "fs";
import { workspace, ExtensionContext, commands, window, OutputChannel } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let outputChannel: OutputChannel;

export function activate(context: ExtensionContext) {
  outputChannel = window.createOutputChannel("PHP LSP");
  const config = workspace.getConfiguration("phpLsp");
  if (!config.get<boolean>("enable", true)) return;
  startServer(context);
  context.subscriptions.push(commands.registerCommand("phpLsp.restart", () => restartServer(context)));
  context.subscriptions.push(commands.registerCommand("phpLsp.reindex", () => { client?.sendNotification("phpLsp/reindex"); window.showInformationMessage("PHP LSP: Re-indexing..."); }));
}

function findServerBinary(context: ExtensionContext): string {
  const configPath = workspace.getConfiguration("phpLsp").get<string>("executablePath", "");
  if (configPath && fs.existsSync(configPath)) return configPath;
  const platform = process.platform, arch = process.arch;
  const ext = platform === "win32" ? ".exe" : "";
  const bundled = path.join(context.extensionPath, "bin", `${platform}-${arch}`, `php-lsp${ext}`);
  if (fs.existsSync(bundled)) return bundled;
  return "php-lsp";
}

function startServer(context: ExtensionContext) {
  const serverPath = findServerBinary(context);
  const config = workspace.getConfiguration("phpLsp");
  const serverOptions: ServerOptions = { command: serverPath, args: ["--transport", "stdio"], transport: TransportKind.stdio };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "php" }],
    synchronize: { fileEvents: [workspace.createFileSystemWatcher("**/*.php"), workspace.createFileSystemWatcher("**/composer.json")] },
    outputChannel,
    initializationOptions: {
      phpVersion: config.get("phpVersion", "8.5"), framework: config.get("framework", "auto"),
      containerAware: config.get("containerAware", true), diagnosticsEnabled: config.get("diagnostics.enable", true),
      maxIndexFiles: config.get("maxIndexFiles", 10000), excludePaths: config.get("excludePaths", ["vendor", "node_modules", ".git"]),
    },
  };
  client = new LanguageClient("phpLsp", "PHP LSP", serverOptions, clientOptions);
  client.start().then(() => outputChannel.appendLine("PHP LSP server started"), (err) => window.showErrorMessage(`PHP LSP failed: ${err.message}`));
  context.subscriptions.push(client);
}

async function restartServer(context: ExtensionContext) {
  if (client) { await client.stop(); client = undefined; }
  startServer(context);
  window.showInformationMessage("PHP LSP: Server restarted");
}

export function deactivate(): Thenable<void> | undefined { return client?.stop(); }
