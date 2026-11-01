// Prototype: runs the language server's WebAssembly build inside the browser.
// The desktop entry point is extension.ts; nothing here is shared with it yet.
import { ExtensionContext, Uri, workspace, window } from "vscode";
import { BaseLanguageClient, CloseAction, ErrorAction, InitializeParams, LanguageClientOptions, MessageTransports } from "vscode-languageclient/browser";
import { Wasm, ProcessOptions } from "@vscode/wasm-wasi/v1";
import { createStdioOptions, startServer } from "@vscode/wasm-wasi-lsp";

// The server sees the workspace here, which is where the workspaceFolder mount puts it.
const serverRoot = "file:///workspace";

// Safety limits. An earlier run of this prototype took down the whole machine, so
// nothing here may grow without bound: the server's memory, what it logs, or restarts.
const MAX_WASM_PAGES = 8192; // 512 MB at 64 KB a page
const MAX_LOGGED_BYTES = 256 * 1024;

let client: BaseLanguageClient | undefined;

// The browser client only talks to a Worker it starts itself, so this one is
// handed the transports of the WASI process instead.
class WasiLanguageClient extends BaseLanguageClient {
  constructor(id: string, name: string, options: LanguageClientOptions, private readonly transports: () => Promise<MessageTransports>) {
    super(id, name, options);
  }

  protected createMessageTransports(): Promise<MessageTransports> {
    return this.transports();
  }

  // The client only sends a root for file: workspaces, and a virtual one isn't.
  protected fillInitializeParams(params: InitializeParams): void {
    super.fillInitializeParams(params);
    params.rootUri = serverRoot;
    params.rootPath = "/workspace";
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const output = window.createOutputChannel("Tusk PHP (web)");
  const folder = workspace.workspaceFolders?.[0];
  if (!folder) {
    output.appendLine("No workspace folder, not starting.");
    return;
  }

  const started = Date.now();
  const log = (message: string) => output.appendLine(`[${((Date.now() - started) / 1000).toFixed(2)}s] ${message}`);

  const serverOptions = async () => {
    log("starting");
    log("loading the WASI engine");
    const wasm = await Wasm.load();
    log("reading the server");
    const bits = await workspace.fs.readFile(Uri.joinPath(context.extensionUri, "bin", "wasm", "tusk-php.wasm"));
    const module = await WebAssembly.compile(bits as BufferSource);
    log(`compiled ${bits.byteLength} bytes`);

    const options: ProcessOptions = {
      stdio: createStdioOptions(),
      args: ["--transport", "stdio"],
      mountPoints: [{ kind: "workspaceFolder" }],
    };
    const process = await wasm.createProcess("tusk-php", module, { initial: 160, maximum: MAX_WASM_PAGES, shared: true }, options);
    log("process created");
    const decoder = new TextDecoder("utf-8");
    let logged = 0;
    process.stderr!.onData((data) => {
      if (logged >= MAX_LOGGED_BYTES) return;
      logged += data.byteLength;
      output.append(decoder.decode(data));
      if (logged >= MAX_LOGGED_BYTES) output.appendLine("\n[server log limit reached, dropping the rest]");
    });
    return (await startServer(process)) as unknown as MessageTransports;
  };

  const root = folder.uri.toString(true).replace(/\/$/, "");
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "php" }],
    outputChannel: output,
    // Never restart on its own: a crash loop would pile up memory and logs.
    errorHandler: {
      error: () => ({ action: ErrorAction.Shutdown }),
      closed: () => ({ action: CloseAction.DoNotRestart }),
    },
    uriConverters: {
      code2Protocol: (uri) => {
        const value = uri.toString(true);
        return value.startsWith(root) ? serverRoot + value.slice(root.length) : value;
      },
      protocol2Code: (value) =>
        Uri.parse(value.startsWith(serverRoot) ? root + value.slice(serverRoot.length) : value),
    },
  };

  client = new WasiLanguageClient("tuskPhpLsp", "Tusk PHP", clientOptions, serverOptions);
  try {
    await client.start();
    log("server started");
  } catch (err) {
    log(`failed to start: ${err}`);
  }
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop();
}
