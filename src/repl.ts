import * as vscode from 'vscode';
import * as rpc from 'vscode-jsonrpc';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import * as vslc from 'vscode-languageclient';
import * as settings from './settings';
import * as juliaexepath from './juliaexepath';
import {generatePipeName} from './utils';
import * as telemetry from './telemetry';
import * as jlpkgenv from './jlpkgenv';
import * as fs from 'async-file';

let g_context: vscode.ExtensionContext = null;
let g_settings: settings.ISettings = null;
let g_languageClient: vslc.LanguageClient = null;

let g_terminal: vscode.Terminal = null

let g_plots: Array<string> = new Array<string>();
let g_currentPlotIndex: number = 0;
let g_plotPanel: vscode.WebviewPanel | undefined = undefined;

let g_replVariables: string = '';

let c_juliaPlotPanelActiveContextKey = 'jlplotpaneFocus';

function getPlotPaneContent() {
    if (g_plots.length == 0) {
        return '<html></html>';
    }
    else {
        return g_plots[g_currentPlotIndex];
    }
}

function showPlotPane() {
    telemetry.traceEvent('command-showplotpane');
    let plotTitle = g_plots.length > 0 ? `Julia Plots (${g_currentPlotIndex+1}/${g_plots.length})` : "Julia Plots (0/0)";
    if (!g_plotPanel) {
        // Otherwise, create a new panel
        g_plotPanel = vscode.window.createWebviewPanel('jlplotpane', plotTitle, {preserveFocus: true, viewColumn: vscode.ViewColumn.Active}, {enableScripts: true});
        g_plotPanel.webview.html = getPlotPaneContent();
        vscode.commands.executeCommand('setContext', c_juliaPlotPanelActiveContextKey, true);

        // Reset when the current panel is closed
        g_plotPanel.onDidDispose(() => {
            g_plotPanel = undefined;
            vscode.commands.executeCommand('setContext', c_juliaPlotPanelActiveContextKey, false);
        }, null, g_context.subscriptions);

        g_plotPanel.onDidChangeViewState(({ webviewPanel }) => {
            vscode.commands.executeCommand('setContext', c_juliaPlotPanelActiveContextKey, webviewPanel.active);
        });
    }
    else {
        g_plotPanel.title = plotTitle;
        g_plotPanel.webview.html = getPlotPaneContent();
    }
}

function updatePlotPane() {
    showPlotPane();
}

export function plotPanePrev() {
    telemetry.traceEvent('command-plotpaneprevious');

    if (g_currentPlotIndex > 0) {
        g_currentPlotIndex = g_currentPlotIndex - 1;
        updatePlotPane();
    }
}

export function plotPaneNext() {
    telemetry.traceEvent('command-plotpanenext');

    if (g_currentPlotIndex < g_plots.length - 1) {
        g_currentPlotIndex = g_currentPlotIndex + 1;
        updatePlotPane();
    }
}

export function plotPaneFirst() {
    telemetry.traceEvent('command-plotpanefirst');

    if (g_plots.length > 0) {
        g_currentPlotIndex = 0;
        updatePlotPane();
    }
}

export function plotPaneLast() {
    telemetry.traceEvent('command-plotpanelast');
    if (g_plots.length > 0) {
        g_currentPlotIndex = g_plots.length - 1;
        updatePlotPane();
    }
}

export function plotPaneDel() {
    telemetry.traceEvent('command-plotpanedelete');
    if (g_plots.length > 0) {
        g_plots.splice(g_currentPlotIndex, 1);
        if (g_currentPlotIndex > g_plots.length - 1) {
            g_currentPlotIndex = g_plots.length - 1;
        }
        updatePlotPane();
    }
}

export function plotPaneDelAll() {
    telemetry.traceEvent('command-plotpanedeleteall');
    if (g_plots.length > 0) {
        g_plots.splice(0, g_plots.length);
        g_currentPlotIndex = 0;
        updatePlotPane();
    }
}

export class REPLTreeDataProvider implements vscode.TreeDataProvider<string> {
    private _onDidChangeTreeData: vscode.EventEmitter<string | undefined> = new vscode.EventEmitter<string | undefined>();
    readonly onDidChangeTreeData: vscode.Event<string | undefined> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getChildren(node?: string) {
        if (node) {
            return [node]
        }
        else {
            if (g_terminal) {
                return g_replVariables.split(';').slice(1)
            }
            else {
                return ['no repl attached']
            }
        }
    }

    getTreeItem(node: string): vscode.TreeItem {
        let treeItem: vscode.TreeItem = new vscode.TreeItem(node)
        return treeItem;
    }
}

// TODO Enable again
// let g_REPLTreeDataProvider: REPLTreeDataProvider = null;

function startREPLCommand() {
    telemetry.traceEvent('command-startrepl');

    startREPL(false);
}

async function startREPL(preserveFocus: boolean) {
    if (g_terminal == null) {
        let juliaIsConnectedPromise = startREPLMsgServer()
        let args = path.join(g_context.extensionPath, 'scripts', 'terminalserver', 'terminalserver.jl')
        let exepath = await juliaexepath.getJuliaExePath();
        let pkgenvpath = await jlpkgenv.getEnvPath();
        if (pkgenvpath==null) {
            let jlarg1 = ['-i','--banner=no'].concat(vscode.workspace.getConfiguration("julia").get("additionalArgs"))
            let jlarg2 = [args, process.pid.toString(), vscode.workspace.getConfiguration("julia").get("useRevise").toString(), vscode.workspace.getConfiguration("julia").get("usePlotPane").toString()]
            g_terminal = vscode.window.createTerminal(
                {
                    name: "julia",
                    shellPath: exepath,
                    shellArgs: jlarg1.concat(jlarg2),
                    env: {
                        JULIA_EDITOR: `"${process.execPath}"`
                    }});
        }
        else {
            let env_file_paths = await jlpkgenv.getProjectFilePaths(pkgenvpath);

            let sysImageArgs = [];
            if (vscode.workspace.getConfiguration("julia").get("useCustomSysimage") && env_file_paths.sysimage_path && env_file_paths.project_toml_path && env_file_paths.manifest_toml_path) {
                let date_sysimage = await fs.stat(env_file_paths.sysimage_path);
                let date_manifest = await fs.stat(env_file_paths.manifest_toml_path);

                if (date_sysimage.mtime > date_manifest.mtime) {
                    sysImageArgs = ['-J', env_file_paths.sysimage_path]
                }
                else {
                    vscode.window.showWarningMessage('Julia sysimage for this environment is out-of-date and not used for REPL.')
                }
            }
            let jlarg1 = ['-i', '--banner=no', `--project=${pkgenvpath}`].concat(sysImageArgs).concat(vscode.workspace.getConfiguration("julia").get("additionalArgs"))
            let jlarg2 = [args, process.pid.toString(), vscode.workspace.getConfiguration("julia").get("useRevise").toString(),vscode.workspace.getConfiguration("julia").get("usePlotPane").toString()]
            g_terminal = vscode.window.createTerminal(
                {
                    name: "julia",
                    shellPath: exepath,
                    shellArgs: jlarg1.concat(jlarg2),
                    env: {
                        JULIA_EDITOR: process.platform == 'darwin' ? `"${path.join(vscode.env.appRoot, 'bin', 'code')}"` : `"${process.execPath}"`,
                        JULIA_NUM_THREADS: vscode.workspace.getConfiguration("julia").get("NumThreads").toString()
                    }});
        }
        g_terminal.show(preserveFocus);
        await juliaIsConnectedPromise;
    }
    else {
    g_terminal.show(preserveFocus);
}
}

function processMsg(cmd, payload) {
    if (cmd == 'image/svg+xml') {
        g_currentPlotIndex = g_plots.push(payload) - 1;
        showPlotPane();
    }
    else if (cmd == 'image/png') {
        let plotPaneContent = '<html><img src="data:image/png;base64,' + payload + '" /></html>';
        g_currentPlotIndex = g_plots.push(plotPaneContent) - 1;
        showPlotPane();
    }
    else if (cmd == 'juliavscode/html') {
        g_currentPlotIndex = g_plots.push(payload) - 1;
        showPlotPane();
    }
    else if (cmd == 'application/vnd.vegalite.v2+json') {
        let uriVegaEmbed = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-embed', 'vega-embed.min.js')).with({ scheme: 'vscode-resource' });
        let uriVegaLite = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-lite-2', 'vega-lite.min.js')).with({ scheme: 'vscode-resource' });
        let uriVega = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-3', 'vega.min.js')).with({ scheme: 'vscode-resource' });
        let plotPaneContent = `
            <html>
                <head>
                    <script src="${uriVega}"></script>
                    <script src="${uriVegaLite}"></script>
                    <script src="${uriVegaEmbed}"></script>
                </head>
                <body>
                    <div id="plotdiv"></div>
                </body>
                <style media="screen">
                    .vega-actions a {
                        margin-right: 10px;
                        font-family: sans-serif;
                        font-size: x-small;
                        font-style: italic;
                    }
                </style>
                <script type="text/javascript">
                    var opt = {
                        mode: "vega-lite",
                        actions: false
                    }
                    var spec = ${payload}
                    vegaEmbed('#plotdiv', spec, opt);
                </script>
            </html>`;
        g_currentPlotIndex = g_plots.push(plotPaneContent) - 1;
        showPlotPane();
    }
    else if (cmd == 'application/vnd.vegalite.v3+json') {
        let uriVegaEmbed = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-embed', 'vega-embed.min.js')).with({ scheme: 'vscode-resource' });
        let uriVegaLite = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-lite-3', 'vega-lite.min.js')).with({ scheme: 'vscode-resource' });
        let uriVega = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-5', 'vega.min.js')).with({ scheme: 'vscode-resource' });
        let plotPaneContent = `
            <html>
                <head>
                    <script src="${uriVega}"></script>
                    <script src="${uriVegaLite}"></script>
                    <script src="${uriVegaEmbed}"></script>
                </head>
                <body>
                    <div id="plotdiv"></div>
                </body>
                <style media="screen">
                    .vega-actions a {
                        margin-right: 10px;
                        font-family: sans-serif;
                        font-size: x-small;
                        font-style: italic;
                    }
                </style>
                <script type="text/javascript">
                    var opt = {
                        mode: "vega-lite",
                        actions: false
                    }
                    var spec = ${payload}
                    vegaEmbed('#plotdiv', spec, opt);
                </script>
            </html>`;
        g_currentPlotIndex = g_plots.push(plotPaneContent) - 1;
        showPlotPane();
    }
    else if (cmd == 'application/vnd.vegalite.v4+json') {
        let uriVegaEmbed = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-embed', 'vega-embed.min.js')).with({ scheme: 'vscode-resource' });
        let uriVegaLite = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-lite-4', 'vega-lite.min.js')).with({ scheme: 'vscode-resource' });
        let uriVega = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-5', 'vega.min.js')).with({ scheme: 'vscode-resource' });
        let plotPaneContent = `
            <html>
                <head>
                    <script src="${uriVega}"></script>
                    <script src="${uriVegaLite}"></script>
                    <script src="${uriVegaEmbed}"></script>
                </head>
                <body>
                    <div id="plotdiv"></div>
                </body>
                <style media="screen">
                    .vega-actions a {
                        margin-right: 10px;
                        font-family: sans-serif;
                        font-size: x-small;
                        font-style: italic;
                    }
                </style>
                <script type="text/javascript">
                    var opt = {
                        mode: "vega-lite",
                        actions: false
                    }
                    var spec = ${payload}
                    vegaEmbed('#plotdiv', spec, opt);
                </script>
            </html>`;
        g_currentPlotIndex = g_plots.push(plotPaneContent) - 1;
        showPlotPane();
    }
    else if (cmd == 'application/vnd.vega.v3+json') {
        let uriVegaEmbed = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-embed', 'vega-embed.min.js')).with({ scheme: 'vscode-resource' });
        let uriVega = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-3', 'vega.min.js')).with({ scheme: 'vscode-resource' });
        let plotPaneContent = `
            <html>
                <head>
                    <script src="${uriVega}"></script>
                    <script src="${uriVegaEmbed}"></script>
                </head>
                <body>
                    <div id="plotdiv"></div>
                </body>
                <style media="screen">
                    .vega-actions a {
                        margin-right: 10px;
                        font-family: sans-serif;
                        font-size: x-small;
                        font-style: italic;
                    }
                </style>
                <script type="text/javascript">
                    var opt = {
                        mode: "vega",
                        actions: false
                    }
                    var spec = ${payload}
                    vegaEmbed('#plotdiv', spec, opt);
                </script>
            </html>`;
        g_currentPlotIndex = g_plots.push(plotPaneContent) - 1;
        showPlotPane();
    }
    else if (cmd == 'application/vnd.vega.v4+json') {
        let uriVegaEmbed = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-embed', 'vega-embed.min.js')).with({ scheme: 'vscode-resource' });
        let uriVega = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-4', 'vega.min.js')).with({ scheme: 'vscode-resource' });
        let plotPaneContent = `
            <html>
                <head>
                    <script src="${uriVega}"></script>
                    <script src="${uriVegaEmbed}"></script>
                </head>
                <body>
                    <div id="plotdiv"></div>
                </body>
                <style media="screen">
                    .vega-actions a {
                        margin-right: 10px;
                        font-family: sans-serif;
                        font-size: x-small;
                        font-style: italic;
                    }
                </style>
                <script type="text/javascript">
                    var opt = {
                        mode: "vega",
                        actions: false
                    }
                    var spec = ${payload}
                    vegaEmbed('#plotdiv', spec, opt);
                </script>
            </html>`;
        g_currentPlotIndex = g_plots.push(plotPaneContent) - 1;
        showPlotPane();
    }
    else if (cmd == 'application/vnd.vega.v5+json') {
        let uriVegaEmbed = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-embed', 'vega-embed.min.js')).with({ scheme: 'vscode-resource' });
        let uriVega = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'vega-5', 'vega.min.js')).with({ scheme: 'vscode-resource' });
        let plotPaneContent = `
            <html>
                <head>
                    <script src="${uriVega}"></script>
                    <script src="${uriVegaEmbed}"></script>
                </head>
                <body>
                    <div id="plotdiv"></div>
                </body>
                <style media="screen">
                    .vega-actions a {
                        margin-right: 10px;
                        font-family: sans-serif;
                        font-size: x-small;
                        font-style: italic;
                    }
                </style>
                <script type="text/javascript">
                    var opt = {
                        mode: "vega",
                        actions: false
                    }
                    var spec = ${payload}
                    vegaEmbed('#plotdiv', spec, opt);
                </script>
            </html>`;
        g_currentPlotIndex = g_plots.push(plotPaneContent) - 1;
        showPlotPane();
    }
    else if (cmd == 'application/vnd.plotly.v1+json') {
        let uriPlotly = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'plotly', 'plotly.min.js')).with({ scheme: 'vscode-resource' });
        let plotPaneContent = `
        <html>
        <head>
            <script src="${uriPlotly}"></script>
        </head>
        <body>
        </body>
        <script type="text/javascript">
            gd = (function() {
                var WIDTH_IN_PERCENT_OF_PARENT = 100
                var HEIGHT_IN_PERCENT_OF_PARENT = 100;
                var gd = Plotly.d3.select('body')
                    .append('div').attr("id", "plotdiv")
                    .style({
                        width: WIDTH_IN_PERCENT_OF_PARENT + '%',
                        'margin-left': (100 - WIDTH_IN_PERCENT_OF_PARENT) / 2 + '%',
                        height: HEIGHT_IN_PERCENT_OF_PARENT + 'vh',
                        'margin-top': (100 - HEIGHT_IN_PERCENT_OF_PARENT) / 2 + 'vh'
                    })
                    .node();
                var spec = ${payload};
                Plotly.newPlot(gd, spec.data, spec.layout);
                window.onresize = function() {
                    Plotly.Plots.resize(gd);
                    };
                return gd;
            })();
        </script>
        </html>`;
        g_currentPlotIndex = g_plots.push(plotPaneContent) - 1;
        showPlotPane();
    }
    else if (cmd == 'application/vnd.dataresource+json') {
        let uriAgGrid = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'ag-grid', 'ag-grid-community.min.noStyle.js')).with({ scheme: 'vscode-resource' });
        let uriAgGridCSS = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'ag-grid', 'ag-grid.css')).with({ scheme: 'vscode-resource' });
        let uriAgGridTheme = vscode.Uri.file(path.join(g_context.extensionPath, 'libs', 'ag-grid', 'ag-theme-balham.css')).with({ scheme: 'vscode-resource' });
        let grid_content = `
            <html>
                <head>
                    <script src="${uriAgGrid}"></script>
                    <style> html, body { margin: 0; padding: 0; height: 100%; } </style>
                    <link rel="stylesheet" href="${uriAgGridCSS}">
                    <link rel="stylesheet" href="${uriAgGridTheme}">
                </head>
            <body>
                <div id="myGrid" style="height: 100%; width: 100%;" class="ag-theme-balham"></div>
            </body>
            <script type="text/javascript">
                var payload = ${payload};
                var gridOptions = {
                    onGridReady: event => event.api.sizeColumnsToFit(),
                    onGridSizeChanged: event => event.api.sizeColumnsToFit(),
                    defaultColDef: {
                        resizable: true,
                        filter: true,
                        sortable: true
                    },
                    columnDefs: payload.schema.fields.map(function(x) {
                        if (x.type == "number" || x.type == "integer") {
                            return {
                                field: x.name,
                                type: "numericColumn",
                                filter: "agNumberColumnFilter"
                            };
                        } else if (x.type == "date") {
                            return {
                                field: x.name,
                                filter: "agDateColumnFilter"
                            };
                        } else {
                            return {field: x.name};
                        };
                    }),
                rowData: payload.data
                };
                var eGridDiv = document.querySelector('#myGrid');
                new agGrid.Grid(eGridDiv, gridOptions);
            </script>
        </html>
        `;

        let grid_panel = vscode.window.createWebviewPanel('jlgrid', 'Julia Table', {preserveFocus: true, viewColumn: vscode.ViewColumn.Active}, {enableScripts: true, retainContextWhenHidden: true});
        grid_panel.webview.html = grid_content;
    }
    else if (cmd == 'repl/variables') {
        g_replVariables = payload;
        // TODO Enable again
        // g_REPLTreeDataProvider.refresh();
    }
    else {
        throw new Error();
    }
}

function startREPLMsgServer() {
    let PIPE_PATH = generatePipeName(process.pid.toString(), 'vscode-language-julia-fromrepl');

    let connectedPromise = new Promise(function (resolveCallback, rejectCallback) {
        var server = net.createServer(function (socket) {
            resolveCallback();

        let accumulatingBuffer = new Buffer(0);

            socket.on('data', function (c) {
            accumulatingBuffer = Buffer.concat([accumulatingBuffer, Buffer.from(c)]);
            let s = accumulatingBuffer.toString();
            let index_of_sep_1 = s.indexOf(":");
            let index_of_sep_2 = s.indexOf("\n");

            if (index_of_sep_2 > -1) {
                let cmd = s.substring(0, index_of_sep_1);
                let msg_len_as_string = s.substring(index_of_sep_1 + 1, index_of_sep_2);
                let msg_len = parseInt(msg_len_as_string);
                if (accumulatingBuffer.length >= cmd.length + msg_len_as_string.length + 2 + msg_len) {
                    let payload = s.substring(index_of_sep_2 + 1);
                    if (accumulatingBuffer.length > cmd.length + msg_len_as_string.length + 2 + msg_len) {
                        accumulatingBuffer = Buffer.from(accumulatingBuffer.slice(cmd.length + msg_len_as_string.length + 2 + msg_len + 1));
                    }
                    else {
                        accumulatingBuffer = new Buffer(0);
                    }

                    processMsg(cmd, payload);
                }
            }
        });

            socket.on('close', function (hadError) { server.close(); });
    });

        server.on('close', function () {
            console.log('Server: on close');
        })

    server.listen(PIPE_PATH, function () {
        console.log('Server: on listening');
    })
    });

    return connectedPromise;
}

async function executeCode(text, individualLine) {
    if (!text.endsWith("\n")) {
        text = text + '\n';
    }

    await startREPL(true);
    g_terminal.show(true);
    var lines = text.split(/\r?\n/);
    lines = lines.filter(line => line != '');
    text = lines.join('\n');
    if (individualLine || process.platform == "win32") {
        g_terminal.sendText(text + '\n', false);
    }
    else {
        g_terminal.sendText('\u001B[200~' + text + '\n' + '\u001B[201~', false);
    }
}

function executeSelection() {
    telemetry.traceEvent('command-executejuliacodeinrepl');

    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    var selection = editor.selection;

    var text = selection.isEmpty ? editor.document.lineAt(selection.start.line).text : editor.document.getText(selection);

    // If no text was selected, try to move the cursor to the end of the next line
    if (selection.isEmpty) {
        for (var line = selection.start.line + 1; line < editor.document.lineCount; line++) {
            if (!editor.document.lineAt(line).isEmptyOrWhitespace) {
                var newPos = selection.active.with(line, editor.document.lineAt(line).range.end.character);
                var newSel = new vscode.Selection(newPos, newPos);
                editor.selection = newSel;
                break;
            }
        }
    }
    executeCode(text, selection.isEmpty)
}

async function executeInRepl(code: string, filename: string, start: vscode.Position) {
    let msg = filename + '\n' + start.line.toString() + ':' +
        start.character.toString() + '\n' + code
    sendMessage('repl/runcode', msg)
}

async function executeFile() {
    telemetry.traceEvent('command-executejuliafileinrepl');

    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    let document = editor.document;
    executeInRepl(document.getText(), document.fileName, new vscode.Position(0, 0))
}

async function selectJuliaBlock() {
    if (g_languageClient == null) {
        vscode.window.showErrorMessage('Error: Language server is not running.');
    }
    else {
        var editor = vscode.window.activeTextEditor;
        let params: TextDocumentPositionParams = { textDocument: vslc.TextDocumentIdentifier.create(editor.document.uri.toString()), position: new vscode.Position(editor.selection.start.line, editor.selection.start.character) }

        try {
            let ret_val = await g_languageClient.sendRequest('julia/getCurrentBlockOffsetRange', params);
            vscode.window.activeTextEditor.selection = new vscode.Selection(vscode.window.activeTextEditor.document.positionAt(ret_val[0] - 1), vscode.window.activeTextEditor.document.positionAt(ret_val[1]))
            vscode.window.activeTextEditor.revealRange(new vscode.Range(vscode.window.activeTextEditor.document.positionAt(ret_val[0] - 1), vscode.window.activeTextEditor.document.positionAt(ret_val[1])))
        }
        catch (ex) {
            if (ex.message == "Language client is not ready yet") {
                vscode.window.showErrorMessage('Select code block only works once the Julia Language Server is ready.');
            }
            else {
                throw ex;
            }
        }
    }
}

async function executeJuliaCellInRepl() {
    telemetry.traceEvent('command-executejuliacellinrepl');

    let ed = vscode.window.activeTextEditor;
    let doc = ed.document;
    let rx = new RegExp("^##");
    let curr = ed.selection.active.line;
    var start = curr;
    while (start >= 0) {
        if (rx.test(doc.lineAt(start).text)) {
            break;
        } else {
            start -= 1;
        }
    }
    start += 1;
    var end = start;
    while (end < doc.lineCount) {
        if (rx.test(doc.lineAt(end).text)) {
            break;
        } else {
            end += 1;
        }
    }
    end -= 1;
    let startpos = new vscode.Position(start, 0);
    let endpos = new vscode.Position(end, doc.lineAt(end).text.length);
    let nextpos = new vscode.Position(end + 1, 0);
    let code = doc.getText(new vscode.Range(startpos, endpos));
    executeInRepl(code, doc.fileName, startpos)
    vscode.window.activeTextEditor.selection = new vscode.Selection(nextpos, nextpos)
    vscode.window.activeTextEditor.revealRange(new vscode.Range(nextpos, nextpos))
}

async function executeJuliaBlockInRepl() {
    telemetry.traceEvent('command-executejuliablockinrepl');

    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    var selection = editor.selection;

    if (selection.isEmpty && g_languageClient == null) {
        vscode.window.showErrorMessage('Error: Language server is not running.');
    }
    else if (!selection.isEmpty) {
        let code_to_run = editor.document.getText(selection);

        executeInRepl(code_to_run, editor.document.fileName, selection.start);
    }
    else {
        var editor = vscode.window.activeTextEditor;
        let params: TextDocumentPositionParams = { textDocument: vslc.TextDocumentIdentifier.create(editor.document.uri.toString()), position: new vscode.Position(editor.selection.start.line, editor.selection.start.character) }

        try {
            let ret_val = await g_languageClient.sendRequest('julia/getCurrentBlockOffsetRange', params);

            let start_pos = vscode.window.activeTextEditor.document.positionAt(ret_val[0] - 1)
            let end_pos = vscode.window.activeTextEditor.document.positionAt(ret_val[1])

            let code_to_run = vscode.window.activeTextEditor.document.getText(new vscode.Range(start_pos, end_pos))

            executeInRepl(code_to_run, vscode.window.activeTextEditor.document.fileName, start_pos)

            vscode.window.activeTextEditor.selection = new vscode.Selection(vscode.window.activeTextEditor.document.positionAt(ret_val[2]), vscode.window.activeTextEditor.document.positionAt(ret_val[2]))
            vscode.window.activeTextEditor.revealRange(new vscode.Range(vscode.window.activeTextEditor.document.positionAt(ret_val[2]), vscode.window.activeTextEditor.document.positionAt(ret_val[2])))
        }
        catch (ex) {
            if (ex.message == "Language client is not ready yet") {
                vscode.window.showErrorMessage('Execute code block only works once the Julia Language Server is ready.');
            }
            else {
                throw ex;
            }
        }
    }
}

async function sendMessage(cmd, msg: string) {
    await startREPL(true)
    let sock = generatePipeName(process.pid.toString(), 'vscode-language-julia-torepl')

    let conn = net.connect(sock)
    let payload_size = Buffer.byteLength(msg, 'utf8');
    let outmsg = cmd + ':' + payload_size.toString() + '\n' + msg;
    conn.write(outmsg)
    conn.on('error', () => { vscode.window.showErrorMessage("REPL is not open") })
}

export interface TextDocumentPositionParams {
    textDocument: vslc.TextDocumentIdentifier
    position: vscode.Position
}

let getBlockText = new rpc.RequestType<TextDocumentPositionParams, void, void, void>('julia/getCurrentBlockOffsetRange')

export function activate(context: vscode.ExtensionContext, settings: settings.ISettings) {
    g_context = context;
    g_settings = settings;

    // TODO Enable again
    // g_REPLTreeDataProvider = new REPLTreeDataProvider();
    // context.subscriptions.push(vscode.window.registerTreeDataProvider('REPLVariables', g_REPLTreeDataProvider));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.startREPL', startREPLCommand));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCodeInREPL', executeSelection));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaFileInREPL', executeFile));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCellInREPL', executeJuliaCellInRepl));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaBlockInREPL', executeJuliaBlockInRepl));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.selectBlock', selectJuliaBlock));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.show-plotpane', showPlotPane));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.plotpane-previous', plotPanePrev));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.plotpane-next', plotPaneNext));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.plotpane-first', plotPaneFirst));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.plotpane-last', plotPaneLast));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.plotpane-delete', plotPaneDel));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.plotpane-delete-all', plotPaneDelAll));

    vscode.window.onDidCloseTerminal(terminal => {
        if (terminal == g_terminal) {
            g_terminal = null;
        }
    })
}

export function onDidChangeConfiguration(newSettings: settings.ISettings) {

}

export function onNewLanguageClient(newLanguageClient: vslc.LanguageClient) {
    g_languageClient = newLanguageClient;
}
