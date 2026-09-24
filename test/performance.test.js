process.env.NODE_PATH = require('path').join(__dirname, 'mock-modules') + ''; require('module').Module._initPaths();
const vscode = require('vscode'); const assert = require('assert');
const out = require('path').join(__dirname, '..', 'out') + '/';
const { Pipeline } = require(out + 'pipeline.js'); const { ModelRegistry } = require(out + 'registry.js');
const { PerformanceStore } = require(out + 'performance.js'); const { normalizeEnsemble } = require(out + 'config.js');
const log = { info(){}, warn(){}, error(){}, debug(){} };
const client = { complete: (req, signal) => new Promise((res, rej) => {
  const t = setTimeout(() => res({ text: 'draft ' + req.model, usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }), req.model === 'slow' ? 3000 : 30);
  signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
}) };
const failing = { complete: async req => { if (req.model === 'bad') throw new Error('500 upstream'); return { text: 'x', usage: { cost: 0.01 } }; } };
(async () => {
  const perf = new PerformanceStore({ get(){}, update(){ return Promise.resolve(); } });
  const settings = { proposerTimeoutMs: 5000, proposerContextChars: 9999, logUsage: false, stickySessions: false, performanceMemory: true, modelReasoning: {}, fallbacks: {} };
  const msgs = [{ role: 1, content: [new vscode.LanguageModelTextPart('q')] }];
  await new Pipeline(client, new ModelRegistry(), log, perf).buildAggregatorContext(normalizeEnsemble({ id: 'd', name: 'd', proposers: ['fast', 'fast2', 'slow'], aggregator: 'x', graceSeconds: 0.1 }), msgs, settings, new AbortController().signal);
  await new Pipeline(failing, new ModelRegistry(), log, perf).buildAggregatorContext(normalizeEnsemble({ id: 'f', name: 'f', proposers: ['ok', 'bad'], aggregator: 'x' }), msgs, settings, new AbortController().signal);
  const d = Object.fromEntries(perf.stats('d').map(s => [s.model, s])), f = Object.fromEntries(perf.stats('f').map(s => [s.model, s]));
  assert.strictEqual(d.slow.dropped, 1); assert.strictEqual(d.slow.failed, 0); assert.strictEqual(d.fast.delivered, 1);
  assert.strictEqual(f.bad.failed, 1); assert.strictEqual(f.bad.dropped, 0);
  assert.ok(d.fast.avgCost === 0.01 && d.slow.avgCost === undefined);
  console.log('✓ grace-period cancellations recorded as dropped, errors as failed; costs per model');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
