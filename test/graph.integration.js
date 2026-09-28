/*
 * Integration test against a real graphify install (run in CI on Windows, macOS and Linux).
 * Covers what VS Code would do: detect graphify, build the graph, take the MCP server definition we hand
 * to VS Code, start it exactly like VS Code does (no shell) and talk MCP to it over stdio.
 *
 *   GRAPHIFY_INTEGRATION=1 node test/graph.integration.js
 */
if (!process.env.GRAPHIFY_INTEGRATION) { console.log('skipped (set GRAPHIFY_INTEGRATION=1)'); process.exit(0); }

process.env.NODE_PATH = require('path').join(__dirname, 'mock-modules') + ''; require('module').Module._initPaths();
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');

// ---- extend the vscode mock with what GraphService needs ------------------------------------------
const settings = { 'graph.enabled': true };
const disposable = { dispose() {} };
const messages = [];
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'graph ws-')); // space in the path on purpose
fs.cpSync(path.join(__dirname, '..', 'src'), path.join(ws, 'src'), { recursive: true });
fs.rmSync(path.join(ws, 'src', 'generated'), { recursive: true, force: true });
const folder = { name: 'ws', index: 0, uri: { scheme: 'file', fsPath: ws, toString: () => 'file://' + ws } };
Object.assign(vscode, {
  McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
  ProgressLocation: { ...vscode.ProgressLocation, Notification: 15 },
  ConfigurationTarget: { Global: 1 },
});
Object.assign(vscode.window, {
  withProgress: async (_o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable }),
  showInformationMessage: async m => { messages.push('INFO ' + m); },
  showWarningMessage: async m => { messages.push('WARN ' + m); },
  showErrorMessage: async m => { messages.push('ERR ' + m); },
});
Object.assign(vscode.workspace, {
  isTrusted: true,
  workspaceFolders: [folder],
  getConfiguration: () => ({ get: k => settings[k], update: async () => {} }),
  createFileSystemWatcher: () => ({ onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} }),
  onDidChangeWorkspaceFolders: () => disposable,
  onDidGrantWorkspaceTrust: () => disposable,
});

const { GraphService, describe } = require(path.join(__dirname, '..', 'out', 'graph.js'));
const logs = [];
const log = { info: m => logs.push(m), error: m => logs.push('ERR ' + m), show() {} };

/** Starts the server like VS Code's MCP host (spawn, no shell, definition env merged over process.env). */
async function mcpSession(def) {
  const child = spawn(def.command, def.args, { cwd: def.cwd?.fsPath, env: { ...process.env, ...def.env }, windowsHide: true });
  let buf = '';
  let stderr = '';
  const pending = new Map();
  child.stderr.on('data', c => { stderr += c; });
  child.stdout.on('data', c => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) { continue; }
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out\nstderr:\n${stderr}`)), 60_000);
    pending.set(n, msg => { clearTimeout(timer); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  child.on('error', e => { throw e; });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return { request, close: async () => { child.kill(); await exited; }, stderr: () => stderr };
}

async function checkServer(def, label) {
  const session = await mcpSession(def);
  try {
    const { tools } = await session.request('tools/list', {});
    const names = tools.map(t => t.name);
    for (const t of ['query_graph', 'get_node', 'get_neighbors', 'shortest_path']) { assert.ok(names.includes(t), `${label}: ${t} missing (${names})`); }
    const res = await session.request('tools/call', { name: 'get_neighbors', arguments: { label: 'classifyTool()' } });
    const text = res.content.map(c => c.text).join('\n');
    assert.ok(/toolWords\(\)/.test(text) && /provider\.ts/.test(text), `${label}: unexpected get_neighbors result:\n${text}`);
    const q = await session.request('tools/call', { name: 'query_graph', arguments: { question: 'how are tools classified as read or write' } });
    assert.ok(/classifyTool/.test(q.content.map(c => c.text).join('\n')), `${label}: query_graph didn't find classifyTool`);
    console.log(`✓ ${label}: ${names.length} tools, get_neighbors + query_graph answer from the graph`);
  } finally {
    await session.close();
  }
}

(async () => {
  console.log(`platform ${process.platform}, workspace "${ws}"`);

  // 1) default detection from PATH
  let g = new GraphService(log);
  let s = await g.status();
  console.log(`  detected: ${describe(s)} | cli=${s.cli} | server=${JSON.stringify(s.server)} | python=${s.python}`);
  assert.strictEqual(s.state, 'ready', describe(s));
  assert.deepStrictEqual(s.missing.map(f => f.name), ['ws']);
  assert.strictEqual((await g.provideMcpServerDefinitions()).length, 0, 'no server before a graph exists');
  console.log('✓ detection: ready, no server offered before the graph exists');

  // 2) build (extract --code-only), then update
  assert.strictEqual(await g.build(folder), true, `build failed: ${messages.join('\n')}\n${logs.join('\n')}`);
  assert.ok(fs.existsSync(path.join(ws, 'graphify-out', 'graph.json')));
  assert.ok(logs.some(l => /graphify extract ws: \d+ nodes/.test(l)), logs.join('\n'));
  g.refresh();
  s = await g.status();
  assert.strictEqual(s.graphs.length, 1, describe(s));
  assert.strictEqual(await g.build(folder), true, `update failed: ${messages.join('\n')}`);
  assert.ok(logs.some(l => /graphify update ws/.test(l)), 'second build runs update');
  console.log('✓ build: extract --code-only, then incremental update');

  // 3) the definition VS Code gets, started like VS Code starts it
  g.refresh();
  const [def] = await g.provideMcpServerDefinitions();
  assert.ok(def, 'server definition after build');
  assert.strictEqual(await g.resolveMcpServerDefinition(def), def);
  console.log(`  server: ${def.command} ${def.args.join(' ')}`);
  await checkServer(def, 'MCP via detected launcher');
  g.dispose();

  // 4) fallback: graphify launcher alone (no graphify-mcp next to it) → interpreter parsed from the launcher
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'lone-'));
  const loneCli = path.join(lone, path.basename(s.cli));
  fs.copyFileSync(fs.realpathSync(s.cli), loneCli);
  if (process.platform !== 'win32') { fs.chmodSync(loneCli, 0o755); }
  settings['graph.command'] = loneCli;
  g = new GraphService(log);
  const s2 = await g.status();
  console.log(`  fallback: ${describe(s2)} | server=${JSON.stringify(s2.server)} | python=${s2.python}`);
  assert.strictEqual(s2.state, 'ready', describe(s2));
  assert.deepStrictEqual(s2.server.args, ['-m', 'graphify.serve'], 'falls back to <python> -m graphify.serve');
  assert.ok(path.isAbsolute(s2.python), `interpreter from launcher: ${s2.python}`);
  await checkServer((await g.provideMcpServerDefinitions())[0], 'MCP via interpreter from launcher');
  g.dispose();

  // 5) wrong command → missing-cli, deleted graph → no server
  settings['graph.command'] = 'graphify-does-not-exist';
  g = new GraphService(log);
  assert.strictEqual((await g.status()).state, 'missing-cli');
  g.dispose();
  delete settings['graph.command'];
  g = new GraphService(log);
  const [def2] = await g.provideMcpServerDefinitions();
  fs.rmSync(path.join(ws, 'graphify-out'), { recursive: true, force: true });
  assert.strictEqual(await g.resolveMcpServerDefinition(def2), undefined, 'deleted graph → server not started');
  g.dispose();
  console.log('✓ missing CLI detected; deleted graph is not started');

  console.log('\nALL GRAPH INTEGRATION TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error(e); console.error(logs.join('\n')); process.exit(1); });
