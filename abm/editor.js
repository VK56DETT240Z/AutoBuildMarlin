/**
 * Provider for the Configuration file editor.
 *
 * Configuration editors are used for `Configuration.h` and `Configuration_adv.h`
 * files, which are just C header files. The data is initially parsed as JSON,
 * and applied on changes from the custom editor. Any time the file needs to be
 * reloaded, the JSON is re-parsed and the custom editor is refreshed.
 *
 * This provider:
 *
 * - Sets up the initial webview for the config editor.
 * - Loads scripts and styles in the config editor.
 * - Synchronizes changes between the underlying text document and the config editor.
 */
 'use strict';

 const vscode = require("vscode"),
     vw = vscode.window;

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

var the_document = null;

function updateOptionState(info) {
  const range = new vscode.Range(info.line, 0, info.line, 0),
        text = the_document.getText(range);

  var newtext = text;
  if (info.enabled)
    newtext = text.replace(/^(\s*)\/\/+\s*(#define)(\s{1,3})?(\s*)/, '$1$2 $4');
  else
    newtext = text.replace(/^(\s*)(#define)(\s{1,3})?(\s*)/, '$1//$2 $4')

  // Update the value of non-switch options
  if (info.type != 'switch') {
    const define_regex = /^(\s*)(\/\/\s*)?(#define\s+)([A-Za-z0-9_]+\b)(\s*)(.*?)(\s*)(\/\/.*)?$/;
    const match = define_regex.exec(text);
    newtext = match[1] + match[3] + match[4] + match[5] + info.value;
    if (match[8]) {
      const sp = match[7] ? match[7] : ' '
      newtext += sp + match[8];
    }
  }

  console.log("Before edit:", text);
  console.log("After edit:", newtext);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(the_document.uri, range, newtext);
  const result = vscode.workspace.applyEdit(edit);
  console.log("applyEdit result:", result);

  return result;
}

class ConfigEditorProvider {
  constructor(context) {
    this.context = context;
  }
  static register(context) {
    const provider = new ConfigEditorProvider(context);
    return vw.registerCustomEditorProvider(ConfigEditorProvider.viewType, provider);
  }

  /**
   * Write out the json to a given document.
   */
   updateConfigFile(document, data) {
    console.log('updateConfigFile', data);
    return;

    const edit = new vscode.WorkspaceEdit();

    // Get the line number from the data and make a range starting and ending with that line
    const range = new vscode.Range(data.line, 0, data.line, 0);
    // Do an edit replacing the range with the new text
    edit.replace(document.uri, range, data.text);

    return vscode.workspace.applyEdit(edit);
  }

  handleMessage(e) {
    console.log('handleMessage', e);
    switch (e.type) {
      case 'edit':
        e.data['dirty'] = 'dirty';
        e.data.value = e.value;
        updateOptionState(e.data);
        break;
      case 'toggle':
        e.data['dirty'] = 'dirty';
        e.data.enabled = e.enabled;
        updateOptionState(e.data);
        break;
      case 'hello':
        vw.showInformationMessage('Hello from the webview!');
        break;
    }
  }

  /**
   * Called when the custom editor is opened.
   */
  async resolveCustomTextEditor(document, webviewPanel, _token) {
    // Setup initial content for the webview
    const wv = webviewPanel.webview;
    wv.options = { enableScripts: true };
    wv.html = this.getHtmlForWebview(wv);

    the_document = document;

    function updateWebview() {
      wv.postMessage({
        type: 'update',
        text: document.getText(),
      });
    }

    // Hook up event handlers so that we can synchronize the webview with the text document.
    //
    // The text document acts as our model, so we have to sync change in the document to our
    // editor and sync changes in the editor back to the document.
    //
    // Remember that a single text document can also be shared between multiple custom
    // editors (this happens for example when you split a custom editor)
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        updateWebview();
      }
    });

    // Make sure we get rid of the listener when our editor is closed.
    webviewPanel.onDidDispose(() => { changeDocumentSubscription.dispose(); });

    // Receive message from the webview.
    webviewPanel.webview.onDidReceiveMessage(this.handleMessage);

    updateWebview();
  }

  /**
   * Get the static html used for the editor webviews.
   */
  getHtmlForWebview(webview) {
    // Local path to script and css for the webview
    const jqueryUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'abm', 'js', 'jquery-3.3.1.min.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'abm', 'js', 'editview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'abm', 'css', 'editview.css'));
    // Use a nonce to whitelist which scripts can be run
    const nonce = (0, getNonce)();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet" />
  <script nonce="${nonce}" src="${jqueryUri}"></script>
  <title>Configuration Editor</title>
</head>
<body id="abm-conf">
  <div id="filter-form"><form>
    <label for="filter">Filter:</label><input type="text" id="filter" name="filter" />
    <label for="show-comments"><input type="checkbox" id="show-comments" name="show-comments" checked="checked" />Show Comments</label>
  </form></div>
  <div id="config-form"></div>
  <div class="notes"><div class="add-button"><button>Hello!</button></div></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

}

ConfigEditorProvider.viewType = 'abm.configEditor';
exports.ConfigEditorProvider = ConfigEditorProvider;
