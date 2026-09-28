process.env.NODE_PATH = require('path').join(__dirname, 'mock-modules') + ''; require('module').Module._initPaths();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const out = require('path').join(__dirname, '..', 'out') + '/';
const { interpreterFromLauncher, findExecutable, siblingExecutable, parseBuildSummary } = require(out + 'graph.js');
const { classifyTool } = require(out + 'tools.js');

(async () => {
  // --- interpreter behind console-script launchers
  const B = s => Buffer.from(s, 'latin1');
  assert.strictEqual(interpreterFromLauncher(B('#!/root/.local/share/uv/tools/graphifyy/bin/python\n# -*- coding: utf-8 -*-\nimport sys\n')),
    '/root/.local/share/uv/tools/graphifyy/bin/python', 'uv tool / pipx shebang');
  assert.strictEqual(interpreterFromLauncher(B('#!/usr/bin/python3.12\nimport re\n')), '/usr/bin/python3.12');
  assert.strictEqual(interpreterFromLauncher(B('#!/usr/bin/env python3\n')), 'python3', 'env form resolved later via PATH');
  assert.strictEqual(interpreterFromLauncher(B(`#!/bin/sh\n'''exec' "/Users/a b/venv/bin/python" "$0" "$@"\n' '''\n`)), '/Users/a b/venv/bin/python', "pip's sh wrapper for paths with spaces");
  assert.strictEqual(interpreterFromLauncher(B('#!/bin/bash\necho hi\n')), undefined, 'not a Python launcher');
  // Windows: distlib launcher (exe stub + shebang + zip) and a uv-style trampoline tail
  const stub = Buffer.concat([B('MZ'), Buffer.alloc(100 * 1024, 0x90)]);
  const distlib = Buffer.concat([stub, B('#!C:\\Users\\Al\\pipx\\venvs\\graphifyy\\Scripts\\python.exe\r\n'), B('PK\u0003\u0004zipdata')]);
  assert.strictEqual(interpreterFromLauncher(distlib), 'C:\\Users\\Al\\pipx\\venvs\\graphifyy\\Scripts\\python.exe', 'distlib .exe launcher');
  const trampoline = Buffer.concat([Buffer.alloc(8192, 0x90), B('C:\\Users\\Al\\AppData\\Roaming\\uv\\tools\\graphifyy\\Scripts\\python.exe'), Buffer.from([0x3f, 0, 0, 0]), B('UVUV')]);
  assert.strictEqual(interpreterFromLauncher(trampoline), 'C:\\Users\\Al\\AppData\\Roaming\\uv\\tools\\graphifyy\\Scripts\\python.exe', 'uv trampoline');
  console.log('✓ interpreter detection: shebang, env, sh wrapper, distlib .exe, uv trampoline');

  // --- PATH lookup (POSIX + Windows with PATHEXT), sibling launcher
  const have = set => async p => set.has(p);
  assert.strictEqual(await findExecutable('graphify', { PATH: '/usr/bin:/home/a/.local/bin' }, 'linux', have(new Set(['/home/a/.local/bin/graphify']))), '/home/a/.local/bin/graphify');
  assert.strictEqual(await findExecutable('graphify', { PATH: '/usr/bin' }, 'linux', have(new Set())), undefined);
  assert.strictEqual(await findExecutable('graphify', { Path: 'C:\\py\\Scripts;C:\\Windows', PATHEXT: '.COM;.EXE;.BAT' }, 'win32',
    have(new Set(['C:\\py\\Scripts\\graphify.exe']))), 'C:\\py\\Scripts\\graphify.exe', 'Path + PATHEXT on Windows');
  assert.strictEqual(await findExecutable('/opt/g/graphify', {}, 'linux', have(new Set(['/opt/g/graphify']))), '/opt/g/graphify', 'absolute path as-is');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gtest-'));
  fs.writeFileSync(path.join(tmp, 'graphify'), '');
  fs.writeFileSync(path.join(tmp, 'graphify-mcp'), '');
  assert.strictEqual(await siblingExecutable(path.join(tmp, 'graphify'), 'graphify-mcp'), path.join(tmp, 'graphify-mcp'));
  assert.strictEqual(await siblingExecutable(path.join(tmp, 'graphify'), 'nope'), undefined);
  fs.rmSync(tmp, { recursive: true });
  console.log('✓ executable lookup: PATH, PATHEXT, absolute, graphify-mcp sibling');

  // --- build output parsing
  assert.deepStrictEqual(parseBuildSummary('[graphify extract] wrote /x/graphify-out/graph.json: 542 nodes, 1056 edges, 31 communities'), { nodes: 542, edges: 1056 });
  assert.strictEqual(parseBuildSummary('nothing'), undefined);
  console.log('✓ build summary parsing');

  // --- graphify MCP tools are read-only (usable while exploring); VS Code prefixes MCP tools with mcp_<server>_
  const graphTools = ['query_graph', 'get_node', 'get_neighbors', 'get_community', 'god_nodes', 'graph_stats', 'shortest_path', 'list_prs', 'get_pr_impact'];
  for (const name of graphTools) {
    assert.strictEqual(classifyTool(name), 'read', name);
    assert.strictEqual(classifyTool(`mcp_graphify_${name}`), 'read', `mcp_graphify_${name}`);
  }
  assert.strictEqual(classifyTool('update_graph'), 'write', 'write verbs still win');
  assert.strictEqual(classifyTool('create_path'), 'write');
  console.log('✓ graph tools classified read-only, write verbs still win');

  console.log('\nALL GRAPH TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
