process.env.NODE_PATH = require('path').join(__dirname, 'mock-modules') + ''; require('module').Module._initPaths();
const vscode = require('vscode');
const assert = require('assert');
const out = require('path').join(__dirname, '..', 'out') + '/';
const { OpenRouterEnsembleProvider } = require(out + 'provider.js');
const { PerformanceStore } = require(out + 'performance.js');
const { classifyTool } = require(out + 'tools.js');
const { UsageLedger, ActivityBus } = require(out + 'usage.js');

const logs = [];
const log = { info: m => logs.push(m), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m), debug: m => logs.push('DBG ' + m) };
const memento = { data: {}, get(k) { return this.data[k]; }, update(k, v) { this.data[k] = v; return Promise.resolve(); } };
const secrets = { get: async () => 'sk-or-test', store: async () => {}, delete: async () => {} };

// ---- catalog + fake OpenRouter ---------------------------------------------------------------
const CATALOG = ['agg/final', 'p/a', 'p/b'].map(id => ({ id, name: id, context_length: 200000, top_provider: { max_completion_tokens: 8000 }, supported_parameters: ['tools', 'temperature'], architecture: { input_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' } }));
const DRAFT_A = 'Plan: in auth ts replace the plain string comparison in login with bcrypt compare and use a constant time check, then add a unit test that verifies login rejects wrong passwords and accepts the correct hash for the stored user record';
const DRAFT_B = 'Approach: move session handling into a middleware layer and add rate limiting to the endpoint so brute force attempts are throttled before reaching the handler';
let streamScript = [];          // queue of responses for streaming calls to the final model
const requests = [];            // all requests
function sse(chunks) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`)); c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.01, prompt_tokens_details: { cached_tokens: 700 } } })}\n\n`)); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }), { status: 200 });
}
const toolCall = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
const toolCall2 = (i, id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: i, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
const text = t => ({ choices: [{ delta: { content: t } }] });
const finish = r => ({ choices: [{ delta: {}, finish_reason: r }] });
global.fetch = async (url, init) => {
  if (url.endsWith('/models')) return new Response(JSON.stringify({ data: CATALOG }), { status: 200 });
  const body = JSON.parse(init.body);
  requests.push(body);
  if (!body.stream) {
    const t = body.model === 'p/a' ? DRAFT_A : DRAFT_B;
    return new Response(JSON.stringify({ choices: [{ message: { content: t } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: body.model === 'p/a' ? 0.002 : 0.004 } }), { status: 200 });
  }
  const next = streamScript.shift();
  assert.ok(next, 'unexpected streaming request');
  return sse(next(body));
};

// ---- helpers -----------------------------------------------------------------------------------
const T = name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const TOOLS = [T('read_file'), T('grep_search'), T('memory'), T('replace_string_in_file'), T('run_in_terminal'), T('mcp_foo_bar')];
const U = t => ({ role: 1, content: [new vscode.LanguageModelTextPart(t)], name: undefined });
const A = parts => ({ role: 2, content: parts, name: undefined });
const R = (id, t) => ({ role: 1, content: [new vscode.LanguageModelToolResultPart(id, [new vscode.LanguageModelTextPart(t)])], name: undefined });
async function respond(provider, model, messages, tools = TOOLS) {
  const parts = [];
  await provider.provideLanguageModelChatResponse(model, messages, { tools, toolMode: 1 }, { report: p => parts.push(p) }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  return parts;
}
const ensembleModel = (trigger, extra = {}) => ({ kind: 'ensemble', maxOutputTokens: 8000, ensemble: {
  id: 'e2e-' + trigger + (extra.id || ''), name: 'E2E', strategy: 'plan', proposers: [{ model: 'p/a' }, { model: 'p/b' }], aggregator: 'agg/final',
  critique: false, refine: false, proposerMaxTokens: 1000, trigger, maxExplorationSteps: extra.max ?? 4, graceSeconds: 5, reread: false } });
const draftCalls = () => requests.filter(r => !r.stream).length;

(async () => {
  global.__config = { performanceMemory: true, logUsage: false, stickySessions: true };
  // ---- classification
  assert.deepStrictEqual(['read_file','grep_search','memory','replace_string_in_file','run_in_terminal','mcp_foo_bar','get_terminal_output','manage_todo_list','semantic_search','copilot_getNotebookSummary'].map(classifyTool),
    ['read','read','read','write','write','unknown','write','read','read','read']);
  console.log('✓ tool classification (write verbs win, unknown tools hidden)');

  const perf = new PerformanceStore(memento, log);
  const ledger = new UsageLedger(memento);
  const bus = new ActivityBus(ledger);
  const busEvents = [];
  bus.onDidChange(() => { const a = bus.snapshot().active[0]; if (a) busEvents.push(JSON.parse(JSON.stringify(a))); });
  const provider = new OpenRouterEnsembleProvider(secrets, log, perf, ledger, bus);

  // ---- Scenario A: explore → model requests drafts alone → inline drafts → final edits → later tool step reuses
  const model = ensembleModel('afterExploration');
  let conv = [U('Harden the login in auth.ts')];
  streamScript.push(body => {
    const names = body.tools.map(t => t.function.name);
    assert.deepStrictEqual(names, ['read_file', 'grep_search', 'memory', 'request_expert_drafts'], 'exploration: read-only + handoff tool only');
    assert.ok(body.messages[0].role === 'system' && body.messages[0].content.includes('Phase 1'));
    return [text('Let me look at the code. '), toolCall('c1', 'read_file', { path: 'auth.ts' }), finish('tool_calls')];
  });
  let parts = await respond(provider, model, conv);
  assert.strictEqual(draftCalls(), 0, 'no drafts during exploration');
  assert.ok(parts.some(p => p instanceof vscode.LanguageModelToolCallPart && p.name === 'read_file'));

  conv = [...conv, A([new vscode.LanguageModelTextPart('Let me look at the code. '), new vscode.LanguageModelToolCallPart('c1', 'read_file', { path: 'auth.ts' })]),
    R('c1', 'export function login(user, pw) { return user.pw === pw; } // UNIQUE_FILE_CONTEXT')];
  streamScript.push(() => [toolCall('h1', 'request_expert_drafts', {}), finish('tool_calls')]);
  streamScript.push(body => {
    const names = body.tools.map(t => t.function.name);
    assert.ok(names.includes('replace_string_in_file') && names.includes('run_in_terminal'), 'phase 2: full toolset');
    assert.ok(body.messages[0].content.includes('<drafts>') && body.messages[0].content.includes('lead engineer'));
    const last2 = body.messages.slice(-2);
    assert.strictEqual(last2[0].tool_calls[0].function.name, 'request_expert_drafts');
    assert.strictEqual(last2[1].role, 'tool');
    return [text('Applying the plan. '), toolCall('c2', 'replace_string_in_file', { path: 'auth.ts', newString: 'replace the plain string comparison in login with bcrypt compare and use a constant time check then add a unit test that verifies login rejects wrong passwords' }), finish('tool_calls')];
  });
  parts = await respond(provider, model, conv);
  const draftReqs = requests.filter(r => !r.stream);
  assert.strictEqual(draftReqs.length, 2, 'two drafts');
  for (const d of draftReqs) assert.ok(d.messages[1].content.includes('UNIQUE_FILE_CONTEXT'), 'drafts see the file read during exploration');
  assert.ok(!parts.some(p => p.name === 'request_expert_drafts'), 'handoff call never reaches VS Code');
  assert.ok(parts.some(p => p.name === 'replace_string_in_file'), 'edit reported');
  console.log('✓ explore (read-only) → handoff → drafts see the file content → full toolset, handoff hidden from VS Code');

  conv = [...conv, A([new vscode.LanguageModelTextPart('Applying the plan. '), new vscode.LanguageModelToolCallPart('c2', 'replace_string_in_file', {})]), R('c2', 'ok')];
  streamScript.push(body => { assert.ok(body.messages[0].content.includes('<drafts>')); assert.ok(body.tools.some(t => t.function.name === 'run_in_terminal')); return [text('Done: login now uses bcrypt with a constant time comparison and a unit test verifies that wrong passwords are rejected.'), finish('stop')]; });
  await respond(provider, model, conv);
  assert.strictEqual(draftCalls(), 2, 'later tool steps reuse drafts');
  console.log('✓ later tool steps reuse the drafts (0 extra calls)');

  // usage ledger + live bus for scenario A
  const sum = ledger.summary(1);
  const stages = Object.fromEntries(sum.byStage.map(r => [r.key, r.requests]));
  assert.deepStrictEqual(stages, { explore: 2, draft: 2, final: 2 }, JSON.stringify(stages));
  assert.ok(sum.bySource.length === 1 && sum.bySource[0].label === 'E2E', 'all calls attributed to the ensemble');
  assert.ok(Math.abs(sum.totals.cost - (4 * 0.01 + 0.002 + 0.004)) < 1e-9, 'stream + draft costs');
  assert.ok(Math.abs(sum.byStage.find(r => r.key === 'final').cachedShare - 0.7) < 1e-9);
  const phases = [...new Set(busEvents.map(e => e.phase))];
  assert.deepStrictEqual(phases.filter(p => p !== 'answering').slice(0, 2), ['exploring', 'drafting']);
  assert.ok(busEvents.some(e => e.drafts?.every(d => d.state === 'ok')), 'draft states reach ok');
  assert.strictEqual(bus.snapshot().active.length, 0); assert.strictEqual(bus.snapshot().last.phase, 'done');
  console.log(`✓ usage ledger: ${JSON.stringify(stages)} attributed to the ensemble, ${Math.round(sum.byStage.find(r => r.key === 'final').cachedShare * 100)}% cached; live bus went ${phases.join(' → ')}`);

  // performance record + attribution
  const stats = perf.stats('e2e-afterExploration');
  const a = stats.find(s => s.model === 'p/a'), b = stats.find(s => s.model === 'p/b');
  assert.ok(a.avgAdoption > 0.8 && b.avgAdoption < 0.2, `adoption a=${a.avgAdoption} b=${b.avgAdoption}`);
  assert.ok(Math.abs(a.costShare - 1/3) < 0.01 && Math.abs(b.costShare - 2/3) < 0.01, 'cost share from usage');
  assert.strictEqual(a.confidence, 'insufficient'); assert.strictEqual(a.verdict, 'collecting');
  console.log(`✓ performance memory: adoption p/a=${a.avgAdoption.toFixed(2)} p/b=${b.avgAdoption.toFixed(2)}, cost share ${a.costShare.toFixed(2)}/${b.costShare.toFixed(2)}`);

  // ---- Scenario B: simple question answered directly → no drafts
  let before = draftCalls();
  streamScript.push(() => [text('A regex that matches digits.'), finish('stop')]);
  await respond(provider, model, [U('what does \\d+ match?')]);
  assert.strictEqual(draftCalls(), before, 'direct answer: no drafts');
  console.log('✓ simple question answered directly without drafts');

  // ---- Scenario C: handoff together with a read → drafts on the next step
  conv = [U('Refactor the session store')];
  streamScript.push(() => [toolCall2(0, 'r1', 'read_file', { path: 'session.ts' }), toolCall2(1, 'h2', 'request_expert_drafts', {}), finish('tool_calls')]);
  parts = await respond(provider, model, conv);
  assert.strictEqual(draftCalls(), before, 'not yet: waits for the read result');
  assert.ok(parts.some(p => p.name === 'read_file') && !parts.some(p => p.name === 'request_expert_drafts'));
  conv = [...conv, A([new vscode.LanguageModelToolCallPart('r1', 'read_file', {})]), R('r1', 'class SessionStore { /* SESSION_FILE */ }')];
  streamScript.push(body => { assert.ok(body.messages[0].content.includes('<drafts>')); return [text('ok'), finish('stop')]; });
  await respond(provider, model, conv);
  const newDrafts = requests.filter(r => !r.stream).slice(before);
  assert.strictEqual(newDrafts.length, 2); assert.ok(newDrafts[0].messages[1].content.includes('SESSION_FILE'));
  console.log('✓ handoff alongside a read → drafts on the next step, including that read');

  // ---- Scenario D: exploration limit
  before = draftCalls();
  const limited = ensembleModel('afterExploration', { max: 1, id: '-lim' });
  conv = [U('Explore forever'), A([new vscode.LanguageModelToolCallPart('x1', 'grep_search', {})]), R('x1', 'results')];
  streamScript.push(body => { assert.ok(body.messages[0].content.includes('<drafts>')); return [text('ok'), finish('stop')]; });
  await respond(provider, limited, conv);
  assert.strictEqual(draftCalls() - before, 2);
  assert.ok(logs.some(l => l.includes('exploration limit (1 rounds)')));
  console.log('✓ exploration limit forces drafting');

  // ---- Scenario E: ask mode (no tools) → draft immediately
  before = draftCalls();
  streamScript.push(body => { assert.ok(!body.tools); assert.ok(body.messages[0].content.includes('<drafts>')); return [text('answer'), finish('stop')]; });
  await respond(provider, model, [U('Explain the trade-offs of JWT vs sessions')], []);
  assert.strictEqual(draftCalls() - before, 2);
  console.log('✓ ask mode (no tools) drafts immediately');

  // ---- verdicts over many turns (synthetic)
  const p2 = new PerformanceStore({ data: {}, get() {}, update() { return Promise.resolve(); } });
  for (let i = 0; i < 12; i++) {
    p2.record({ key: 'k' + i, ensembleId: 'x', strategy: 'council', at: i, reviewed: true, drafts: [
      { model: 'good', index: 0, status: 'ok', score: 9, won: true, cost: 0.001 },
      { model: 'bad', index: 1, status: 'ok', score: 4, won: false, cost: 0.003 },
      { model: 'slow', index: 2, status: i % 2 ? 'dropped' : 'ok', score: 6, won: false, cost: 0.001 }] }, ['', '', '']);
  }
  const v = Object.fromEntries(p2.stats('x').map(s => [s.model, s]));
  assert.strictEqual(v.good.verdict, 'strong'); assert.strictEqual(v.bad.verdict, 'weak'); assert.strictEqual(v.slow.verdict, 'slow');
  assert.strictEqual(v.good.confidence, 'preliminary');
  assert.ok(v.bad.reason.includes('60% of the drafting cost'), v.bad.reason);
  console.log(`✓ verdicts: good=${v.good.verdict}, bad=${v.bad.verdict} (${v.bad.reason}), slow=${v.slow.verdict}`);

  await new Promise(r => setTimeout(r, 1100));
  assert.ok(memento.data['openrouterEnsemble.performance.v1'].turns.length >= 3, 'persisted');
  const stored = JSON.stringify(memento.data);
  assert.ok(!stored.includes('UNIQUE_FILE_CONTEXT') && !stored.includes('bcrypt'), 'no content persisted');
  console.log('✓ persisted to globalState, numbers only (no prompts, drafts or code)');
  console.log('\nALL E2E TESTS PASSED');
})().catch(e => { console.error('FAIL', e); console.error(logs.slice(-12).join('\n')); process.exit(1); });
