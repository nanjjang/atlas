import * as vscode from 'vscode';

/** Shared by the diagram panel and the sidebar view, which render two bundles. */
export function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  const values = new Uint32Array(32);
  crypto.getRandomValues(values);
  for (const value of values) {
    nonce += alphabet[value % alphabet.length];
  }
  return nonce;
}

export function contentSecurityPolicy(webview: vscode.Webview, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
    "connect-src 'none'",
  ].join('; ');
}

export function webviewOptionsFor(context: vscode.ExtensionContext): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
  };
}

export function bundleUri(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  fileName: string,
): string {
  return webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', fileName)).toString();
}
