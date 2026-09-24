process.env.NODE_PATH = require('path').join(__dirname, 'mock-modules'); require('module').Module._initPaths();
const assert = require('assert');
const { UsageLedger, ActivityBus, utcDay } = require(require('path').join(__dirname, '..', 'out', 'usage.js'));

const memento = { data: {}, get(k) { return this.data[k]; }, update(k, v) { this.data[k] = v; return Promise.resolve(); } };
const ens = { kind: 'ensemble', id: 'council', name: 'Frontier Council' };
const DAY = 86_400_000, now = Date.now();
const ev = (over) => ({ at: now, model: 'm/a', stage: 'draft', source: ens, promptTokens: 1000, completionTokens: 200, cachedTokens: 0, reasoningTokens: 0, cost: 0.01, ms: 900, ...over });

(async () => {
  const ledger = new UsageLedger(memento);
  ledger.record(ev({}));
  ledger.record(ev({ model: 'm/b', cost: 0.03 }));
  ledger.record(ev({ model: 'm/final', stage: 'final', cost: 0.06, cachedTokens: 800 }));
  ledger.record(ev({ at: now - 3 * DAY, model: 'm/a', cost: 0.02 }));
  ledger.record(ev({ at: now - 20 * DAY, model: 'm/old', cost: 0.5, source: { kind: 'single', id: 'm/old', name: 'Old' } }));
  ledger.record(ev({ at: now - 120 * DAY, model: 'm/ancient', cost: 9 })); // beyond retention

  const s7 = ledger.summary(7, now);
  assert.strictEqual(s7.daily.length, 7);
  assert.strictEqual(s7.daily[6].date, utcDay(now));
  assert.ok(Math.abs(s7.daily[6].total - 0.10) < 1e-9);
  assert.ok(Math.abs(s7.totals.cost - 0.12) < 1e-9, 'range excludes the 20-day-old call');
  assert.deepStrictEqual(s7.byModel.map(r => r.key), ['m/final', 'm/a', 'm/b'], 'cost desc, ties by requests');
  assert.strictEqual(s7.byModel.find(r => r.key === 'm/a').requests, 2);
  assert.strictEqual(s7.bySource[0].label, 'Frontier Council');
  assert.deepStrictEqual(s7.byStage.map(r => r.key).sort(), ['draft', 'final']);
  assert.ok(Math.abs(s7.byModel[0].cachedShare - 0.8) < 1e-9);
  assert.ok(Math.abs(s7.byStage.reduce((a, r) => a + r.share, 0) - 1) < 1e-9, 'shares sum to 1');
  const s30 = ledger.summary(30, now);
  assert.ok(Math.abs(s30.totals.cost - 0.62) < 1e-9 && !s30.byModel.some(r => r.key === 'm/ancient'), '90-day retention');
  console.log('✓ ledger: daily buckets, ranges, breakdown by model/source/stage, cached share, retention');

  await new Promise(r => setTimeout(r, 1700));
  const stored = JSON.stringify(memento.data);
  assert.ok(stored.includes('m/final') && !/prompt|content|messages/i.test(Object.keys(memento.data['openrouterEnsemble.usage.v1'].recent[0]).join(',').replace('promptTokens', '')));
  const reloaded = new UsageLedger(memento);
  assert.ok(Math.abs(reloaded.summary(30, now).totals.cost - 0.62) < 1e-9);
  console.log('✓ ledger persists (numbers and ids only) and reloads');

  // live bus: costs from the ledger flow into the running run
  const bus = new ActivityBus(ledger);
  const id = bus.start(ens);
  bus.update(id, { phase: 'drafting', drafts: [{ model: 'm/a', state: 'pending' }, { model: 'm/b', state: 'pending' }] });
  bus.draft(id, 1, 'dropped', 12000);
  ledger.record(ev({ runId: id, cost: 0.02 }));
  let snap = bus.snapshot();
  assert.strictEqual(snap.active.length, 1);
  assert.strictEqual(snap.active[0].drafts[1].state, 'dropped');
  assert.ok(Math.abs(snap.active[0].cost - 0.02) < 1e-9 && snap.active[0].requests === 1);
  bus.end(id);
  snap = bus.snapshot();
  assert.strictEqual(snap.active.length, 0); assert.strictEqual(snap.last.phase, 'done');
  console.log('✓ activity bus: phases, draft states, live cost from ledger, last run kept');
  console.log('\nALL USAGE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
