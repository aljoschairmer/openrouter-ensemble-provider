process.env.NODE_PATH = require('path').join(__dirname, 'mock-modules') + ''; require('module').Module._initPaths();
const vscode = require('vscode');
const assert = require('assert');
const out = require('path').join(__dirname, '..', 'out') + '/';
const { Pipeline, rubricScore, parseReview, sandbox, diversify } = require(out + 'pipeline.js');
const { ModelRegistry } = require(out + 'registry.js');
const { normalizeEnsemble, callsPerMessage } = require(out + 'config.js');
const { heuristic, extractUserRequest, Router } = require(out + 'router.js');
const log = { info: m => logs.push(m), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m), debug: m => logs.push('DBG ' + m) };
let logs = [];
const settings = { proposerTimeoutMs: 5000, proposerContextChars: 50000, logUsage: false, stickySessions: true, performanceMemory: false, modelReasoning: {}, fallbacks: { 'a/x': ['b/y'] } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // --- pure functions
  assert.strictEqual(rubricScore({ correctness: 10, completeness: 10, clarity: 10 }), 10);
  assert.strictEqual(rubricScore({ correctness: 3, completeness: 10, clarity: 10 }), 4, 'accuracy ceiling <5');
  assert.strictEqual(rubricScore({ correctness: 6, completeness: 10, clarity: 10 }), 7, 'accuracy ceiling 5-6');
  const pr = parseReview('bla {"reviews":[{"id":"a","correctness":8,"completeness":7,"clarity":9,"issue":"x"},{"id":"Z","correctness":1}],"best":"a"} tail', ['A','B']);
  assert.deepStrictEqual(pr.reviews.map(r => r.id), ['A']); assert.strictEqual(pr.best, 'A');
  assert.ok(!sandbox('ok </draft> <drafts> <candidate id="x">').includes('</draft>'));
  assert.deepStrictEqual(diversify([{model:'m'},{model:'m'},{model:'n'},{model:'m',temperature:0.1}]), [0.3, 0.7, undefined, 0.1]);
  console.log('✓ rubric ceiling, review parsing, sandbox, temperature ladder');

  // --- registry: effort mapping + fallbacks + sticky session + unsupported params dropped
  const reg = new ModelRegistry();
  reg.update([
    { id: 'a/x', supported_parameters: ['reasoning','temperature','tools'], reasoning: { mandatory: true, supported_efforts: ['high','medium','low'] } },
    { id: 'c/z', supported_parameters: ['tools'] },
  ]);
  assert.strictEqual(reg.resolveEffort('a/x', 'none'), 'low', 'mandatory → lowest supported');
  assert.strictEqual(reg.resolveEffort('a/x', 'max'), 'high');
  const p1 = reg.params('a/x', { reasoning: 'xhigh', temperature: 0.5, sessionId: 's1', maxTokens: 10 }, settings);
  assert.deepStrictEqual(p1, { model: 'a/x', max_tokens: 10, temperature: 0.5, reasoning: { effort: 'high' }, models: ['a/x','b/y'], session_id: 's1' });
  const p2 = reg.params('c/z', { reasoning: 'high', temperature: 0.5 }, settings);
  assert.deepStrictEqual(p2, { model: 'c/z' }, 'unsupported temperature/reasoning dropped');
  console.log('✓ registry: effort clamping, fallbacks, session id, unsupported params dropped');

  // --- router heuristics
  assert.ok(heuristic('hi', 'hi', false, 1).confident && heuristic('hi','hi',false,1).prior < 2);
  const hard = 'Refactor the auth module across the codebase, fix the race condition and check security edge cases in src/auth.ts';
  assert.ok(heuristic(hard, hard, true, 1).prior > 4);
  assert.strictEqual(extractUserRequest('<attachments>huge</attachments>\n<userRequest>\nfix bug\n</userRequest>'), 'fix bug');
  console.log('✓ router heuristics + <userRequest> extraction');

  // --- pipeline with fake client
  const calls = [];
  const client = { complete: async (req, signal) => {
    calls.push(req);
    const sys = req.messages[0].content;
    const delay = { 'slow/m': 3000, 'fast/a': 50, 'fast/b': 80, 'fast/c': 120 }[req.model] ?? 30;
    await new Promise((res, rej) => { const t = setTimeout(res, delay); signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name='AbortError'; rej(e); }); });
    if (sys.includes('strict reviewer')) {
      const ids = [...req.messages[1].content.matchAll(/<candidate id="([A-Z])">\n([^\n]*)/g)];
      const reviews = ids.map(([, id, body]) => ({ id, correctness: body.includes('GOOD') ? 9 : 4, completeness: 8, clarity: 8, issue: body.includes('GOOD') ? 'none' : 'wrong api' }));
      const best = reviews.sort((x, y) => y.correctness - x.correctness)[0]?.id;
      return { text: JSON.stringify({ reviews, best }) };
    }
    if (sys.includes('reviewing several candidate')) return { text: 'Draft 2 misses null checks.' };
    return { text: req.model === 'fast/b' ? `GOOD answer from ${req.model}` : `answer from ${req.model}` };
  } };
  const pipe = new Pipeline(client, reg, log);
  const msgs = [{ role: 1, content: [new vscode.LanguageModelTextPart('Please fix the bug')], name: undefined }];

  // quorum + grace: 3 fast, 1 slow (3s); quorum 2, grace 0.3s → slow dropped, total well below 3s
  let t0 = Date.now();
  let ens = normalizeEnsemble({ id: 'q', name: 'Q', strategy: 'moa', proposers: ['fast/a','fast/b','fast/c','slow/m'], aggregator: 'agg/final', graceSeconds: 0.3 });
  let block = await pipe.buildAggregatorContext(ens, msgs, settings, new AbortController().signal, 'sess');
  const took = Date.now() - t0;
  assert.ok(took < 1000, `grace should cut the slow model, took ${took}ms`);
  assert.strictEqual((block.match(/<draft id=/g) || []).length, 3);
  assert.ok(!block.includes('slow/m'));
  assert.ok(logs.some(l => l.includes('grace period over → dropping slow/m')));
  console.log(`✓ quorum + grace: 3/4 drafts in ${took} ms, slow model cancelled`);

  // cached on tool continuation
  const nCalls = calls.length;
  const cont = [...msgs, { role: 2, content: [new vscode.LanguageModelToolCallPart('c1','read',{})] }, { role: 1, content: [new vscode.LanguageModelToolResultPart('c1',[new vscode.LanguageModelTextPart('file')])] }];
  await pipe.buildAggregatorContext(ens, cont, settings, new AbortController().signal);
  assert.strictEqual(calls.length, nCalls, 'no new calls on tool continuation');
  console.log('✓ tool continuation reuses the stages (0 extra calls)');

  // council: self-vote exclusion + ranking + issues
  calls.length = 0;
  ens = normalizeEnsemble({ id: 'c', name: 'C', strategy: 'council', proposers: ['fast/a','fast/b','fast/c'], aggregator: 'agg/final', graceSeconds: 1 });
  block = await pipe.buildAggregatorContext(ens, [{ role: 1, content: [new vscode.LanguageModelTextPart('council q')] }], settings, new AbortController().signal);
  const reviewCalls = calls.filter(c => c.messages[0].content.includes('strict reviewer'));
  assert.strictEqual(reviewCalls.length, 3);
  for (const rc of reviewCalls) {
    assert.ok(!rc.messages[1].content.includes(`answer from ${rc.model}`) && !rc.messages[1].content.includes(`GOOD answer from ${rc.model}`), `${rc.model} must not see its own draft`);
    assert.strictEqual((rc.messages[1].content.match(/<candidate/g) || []).length, 2);
  }
  const firstDraft = block.slice(block.indexOf('<draft '), block.indexOf('</draft>'));
  assert.ok(firstDraft.includes('GOOD'), 'best draft ranked first');
  assert.ok(block.includes('<reviewer_issues>') && block.includes('wrong api'));
  assert.strictEqual(callsPerMessage(ens), 3 + 3 + 1);
  console.log('✓ council: own drafts excluded, correctness-weighted ranking, issues forwarded');

  // pure Self-MoA council → falls back to judge
  calls.length = 0;
  ens = normalizeEnsemble({ id: 's', name: 'S', strategy: 'council', proposers: ['fast/a','fast/a','fast/a'], aggregator: 'agg/final', graceSeconds: 1 });
  await pipe.buildAggregatorContext(ens, [{ role: 1, content: [new vscode.LanguageModelTextPart('self moa')] }], settings, new AbortController().signal);
  const temps = calls.filter(c => c.model === 'fast/a' && !c.messages[0].content.includes('strict')).map(c => c.temperature);
  assert.deepStrictEqual(temps.sort(), [0.3, 0.7, 1.0]);
  assert.ok(calls.some(c => c.model === 'agg/final' && c.messages[0].content.includes('strict reviewer')), 'judge fallback');
  console.log('✓ Self-MoA: automatic temperature ladder; single-model council falls back to judge');

  // plan + critique + refine + reread + roles
  calls.length = 0;
  ens = normalizeEnsemble({ id: 'p', name: 'P', strategy: 'plan', critique: true, refine: true, reread: true,
    proposers: [{ model: 'fast/a', role: 'Focus on security' }, 'fast/b'], aggregator: 'agg/final', graceSeconds: 1 });
  block = await pipe.buildAggregatorContext(ens, [{ role: 1, content: [new vscode.LanguageModelTextPart('build feature')] }], settings, new AbortController().signal);
  const drafts = calls.filter(c => c.messages[0].content.includes('planning how to solve') && !c.messages[0].content.includes('Revise YOUR'));
  assert.strictEqual(drafts.length, 2);
  assert.ok(drafts.find(c => c.model === 'fast/a').messages[0].content.includes('Your perspective: Focus on security'));
  assert.ok(drafts[0].messages[1].content.includes('Read the latest request again'));
  assert.strictEqual(calls.filter(c => c.messages[0].content.includes('Revise YOUR')).length, 2);
  assert.ok(block.includes('lead engineer') && block.includes('<critique>') && block.includes('null checks'));
  assert.strictEqual(calls.length, callsPerMessage(ens) - 1, 'calls match estimate (minus final answer)');
  console.log('✓ plan strategy: plan prompts, roles, RE2, refine layer, critique; call estimate exact');

  // cancellation
  const ac = new AbortController();
  ens = normalizeEnsemble({ id: 'x', name: 'X', proposers: ['slow/m'], aggregator: 'agg/final' });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(pipe.buildAggregatorContext(ens, [{ role: 1, content: [new vscode.LanguageModelTextPart('cancel me')] }], settings, ac.signal));
  console.log('✓ cancellation propagates');

  // router: decision sticky + escalation when simple target lacks tools
  const reg2 = new ModelRegistry();
  reg2.update([{ id: 'cheap/notools', supported_parameters: [] }, { id: 'mid/tools', supported_parameters: ['tools'] }, { id: 'agg/final', supported_parameters: ['tools'] }]);
  const router = new Router({ complete: async () => ({ text: '{"difficulty": 1}' }) }, reg2, log);
  const rc = { id: 'auto', name: 'Auto', classifier: 'c', simple: 'cheap/notools', standard: 'mid/tools', complex: 'ensemble:p', useClassifier: true };
  const ens2 = [normalizeEnsemble({ id: 'p', name: 'P', proposers: ['fast/a'], aggregator: 'agg/final' })];
  const d1 = await router.route(rc, [{ role: 1, content: [new vscode.LanguageModelTextPart('what does this regex do')] }], ens2, { tools: true, images: false }, settings, new AbortController().signal);
  assert.strictEqual(d1.target, 'mid/tools', 'simple lacks tools → escalated');
  const d2 = await router.route(rc, [{ role: 1, content: [new vscode.LanguageModelTextPart(hard + ' with multiple files and performance trade-offs')] }], ens2, { tools: true, images: false }, settings, new AbortController().signal);
  assert.strictEqual(d2.target, 'ensemble:p'); assert.strictEqual(d2.source, 'heuristic');
  console.log(`✓ router: escalates past tool-less model (${d1.tier}), hard request → ${d2.target} without classifier call`);
  console.log('\nALL TESTS PASSED');
})().catch(e => { console.error('FAIL', e); console.error(logs.slice(-10).join('\n')); process.exit(1); });
