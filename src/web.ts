// Runs the language server's WebAssembly build inside the browser, for vscode.dev
// and github.dev. The desktop entry point is extension.ts.
import { commands, ExtensionContext, extensions, Uri, workspace, window } from "vscode";
import { BaseLanguageClient, CloseAction, ErrorAction, InitializeParams, LanguageClientOptions, MessageTransports } from "vscode-languageclient/browser";
import { Wasm, ProcessOptions } from "@vscode/wasm-wasi/v1";
import { createStdioOptions, startServer } from "@vscode/wasm-wasi-lsp";

// The server sees the workspace here, which is where the workspaceFolder mount puts it.
const serverRoot = "file:///workspace";

// The extension that runs WebAssembly. It isn't a declared dependency, as that
// would install it for everyone on desktop too, where it's never used.
const WASI_ENGINE = "ms-vscode.wasm-wasi-core";

// Safety limits. An earlier run of this runtime took down a whole machine, so
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

// Sets the maximum size of a module's memory, by rewriting its memory section. Go's
// builds declare their own memory with no maximum, which leaves the 4 GB of
// WebAssembly as the only limit, and they ignore one passed to the WASI engine. With
// this the browser refuses to grow past it, and the server exits out of memory.
function withMemoryLimit(bits: Uint8Array, maxPages: number): Uint8Array {
  const readLeb = (at: number): [number, number] => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = bits[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return [value, at];
  };
  const writeLeb = (value: number): number[] => {
    const out: number[] = [];
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      out.push(value > 0 ? byte | 0x80 : byte);
    } while (value > 0);
    return out;
  };

  let at = 8; // past the magic number and version
  while (at < bits.length) {
    const start = at;
    const id = bits[at++];
    const [size, body] = readLeb(at);
    if (id === 5) {
      const [count, flagsAt] = readLeb(body);
      if (count !== 1) break;
      const [initial] = readLeb(flagsAt + 1);
      const content = [...writeLeb(1), 1, ...writeLeb(initial), ...writeLeb(maxPages)];
      const section = [5, ...writeLeb(content.length), ...content];
      const result = new Uint8Array(start + section.length + bits.length - (body + size));
      result.set(bits.subarray(0, start));
      result.set(section, start);
      result.set(bits.subarray(body + size), start + section.length);
      return result;
    }
    at = body + size;
  }
  // Better not to start than to run without the limit.
  throw new Error("couldn't set the server's memory limit");
}

// Offers to install the engine, which needs a reload to take effect.
async function offerWasiEngine(): Promise<void> {
  const install = "Install";
  const choice = await window.showInformationMessage("Tusk PHP needs the WebAssembly Execution Engine extension to run in the browser.", install);
  if (choice !== install) return;
  await commands.executeCommand("workbench.extensions.installExtension", WASI_ENGINE);
  const reload = "Reload";
  if (await window.showInformationMessage("Reload the window to start Tusk PHP.", reload) === reload) {
    await commands.executeCommand("workbench.action.reloadWindow");
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const output = window.createOutputChannel("Tusk PHP (web)");
  const folder = workspace.workspaceFolders?.[0];
  if (!folder) {
    output.appendLine("No workspace folder, not starting.");
    return;
  }
  // The engine shares memory with the server's process, which browsers only allow
  // on cross-origin isolated pages.
  if (typeof SharedArrayBuffer === "undefined") {
    output.appendLine("This page isn't cross-origin isolated, so WebAssembly threads aren't available. Not starting.");
    window.showWarningMessage("Tusk PHP can't start here: this page isn't cross-origin isolated.");
    return;
  }
  if (!extensions.getExtension(WASI_ENGINE)) {
    output.appendLine(`${WASI_ENGINE} isn't installed, not starting.`);
    void offerWasiEngine();
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
    const module = await WebAssembly.compile(withMemoryLimit(bits, MAX_WASM_PAGES) as BufferSource);
    log(`compiled ${bits.byteLength} bytes`);

    const options: ProcessOptions = {
      stdio: createStdioOptions(),
      args: ["--transport", "stdio"],
      // Mounted by hand so it's always at /workspace, even with several folders open.
      mountPoints: [{ kind: "vscodeFileSystem", uri: folder.uri, mountPoint: "/workspace" }],
    };
    const process = await wasm.createProcess("tusk-php", module, options);
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
  const config = workspace.getConfiguration("tuskPhpLsp");
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "php", scheme: folder.uri.scheme }],
    synchronize: { fileEvents: [workspace.createFileSystemWatcher("**/*.php"), workspace.createFileSystemWatcher("**/composer.{json,lock}")] },
    outputChannel: output,
    // The same settings as on desktop, except for PHPStan and Pint: a browser can't run them.
    initializationOptions: {
      phpVersion: config.get("phpVersion", "8.5"),
      framework: config.get("framework", "auto"),
      containerAware: config.get("containerAware", true),
      diagnosticsEnabled: config.get("diagnostics.enable", true),
      phpstanEnabled: false,
      pintEnabled: false,
      maxIndexFiles: userSetting<number>(config, "maxIndexFiles"),
      excludePaths: config.get("excludePaths", ["vendor", "node_modules", ".git"]),
      phpManualLocale: config.get("phpManual.locale", ""),
      composer: { hover: { enable: config.get("composer.hover.enable", true) } },
    },
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
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.restart", async () => {
    await client?.stop();
    await client?.start();
  }));
  context.subscriptions.push(commands.registerCommand("tuskPhpLsp.reindex", () => client?.sendNotification("tuskPhpLsp/reindex")));
  try {
    await client.start();
    log("server started");
  } catch (err) {
    log(`failed to start: ${err}`);
    window.showErrorMessage("Tusk PHP couldn't start. See the Tusk PHP (web) output for details.");
  }
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop();
}

// The value the user set for a setting, or undefined when they set none. Settings
// read this way are left out of initializationOptions unless set, so the server's
// own default applies: for maxIndexFiles that is no limit on desktop and 10,000
// in the browser, where memory is tight.
function userSetting<T>(config: { inspect<V>(key: string): { globalValue?: V; workspaceValue?: V; workspaceFolderValue?: V } | undefined }, key: string): T | undefined {
  const value = config.inspect<T>(key);
  return value?.workspaceFolderValue ?? value?.workspaceValue ?? value?.globalValue;
}
