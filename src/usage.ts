import * as vscode from 'vscode';

/*
 * Two data layers for the sidebar:
 * - UsageLedger: every OpenRouter call this extension makes, aggregated into UTC-day buckets (90 days)
 *   plus a short list of recent calls. Numbers and model ids only; never prompts or answers.
 * - ActivityBus: what is running right now (routing, exploring, drafting, reviewing, answering).
 */

export type Stage = 'single' | 'final' | 'explore' | 'draft' | 'refine' | 'review' | 'judge' | 'critique' | 'classifier';
export const STAGES: readonly Stage[] = ['single', 'final', 'explore', 'draft', 'refine', 'review', 'judge', 'critique', 'classifier'];

export interface Source {
	kind: 'single' | 'ensemble' | 'router';
	id: string;
	name: string;
}

/** Attached to every OpenRouter call so the client can attribute its usage. */
export interface CallMeta {
	stage: Stage;
	source: Source;
	runId?: string;
}

export interface UsageEvent {
	at: number;
	model: string;
	stage: Stage;
	source: Source;
	runId?: string;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cost: number;
	ms: number;
}

interface Bucket { requests: number; prompt: number; completion: number; cached: number; reasoning: number; cost: number }

export interface BreakdownRow {
	key: string;
	label: string;
	requests: number;
	tokens: number;
	cachedShare: number;
	cost: number;
	share: number;
}

export interface UsageSummary {
	days: number;
	/** Oldest first; one entry per UTC day, including days without usage. */
	daily: { date: string; total: number; byModel: Record<string, number> }[];
	totals: { cost: number; requests: number; prompt: number; completion: number; cached: number };
	byModel: BreakdownRow[];
	bySource: BreakdownRow[];
	byStage: BreakdownRow[];
	recent: UsageEvent[];
}

const STORAGE_KEY = 'openrouterEnsemble.usage.v1';
const RETENTION_DAYS = 90;
const RECENT = 40;
const SEP = '\u0001';

export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export class UsageLedger {
	/** day → "model␁stage␁kind␁id" → bucket */
	private days: Record<string, Record<string, Bucket>>;
	private recent: UsageEvent[];
	/** Source names by "kind␁id", so renamed ensembles show their current name. */
	private names: Record<string, string>;
	private saveTimer?: NodeJS.Timeout;
	private readonly emitter = new vscode.EventEmitter<UsageEvent>();
	readonly onDidRecord = this.emitter.event;

	constructor(private readonly memento: vscode.Memento) {
		const stored = memento.get<{ days?: UsageLedger['days']; recent?: UsageEvent[]; names?: Record<string, string> }>(STORAGE_KEY);
		this.days = stored?.days ?? {};
		this.recent = stored?.recent ?? [];
		this.names = stored?.names ?? {};
	}

	record(e: UsageEvent) {
		const day = utcDay(e.at);
		const key = [e.model, e.stage, e.source.kind, e.source.id].join(SEP);
		const b = ((this.days[day] ??= {})[key] ??= { requests: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, cost: 0 });
		b.requests++;
		b.prompt += e.promptTokens;
		b.completion += e.completionTokens;
		b.cached += e.cachedTokens;
		b.reasoning += e.reasoningTokens;
		b.cost += e.cost;
		this.names[`${e.source.kind}${SEP}${e.source.id}`] = e.source.name;

		this.recent.unshift(e);
		if (this.recent.length > RECENT) { this.recent.length = RECENT; }
		this.prune();
		this.scheduleSave();
		this.emitter.fire(e);
	}

	summary(days: number, now = Date.now()): UsageSummary {
		const dates: string[] = [];
		for (let i = days - 1; i >= 0; i--) { dates.push(utcDay(now - i * 86_400_000)); }

		const totals = { cost: 0, requests: 0, prompt: 0, completion: 0, cached: 0 };
		const acc = { model: new Map<string, Bucket>(), source: new Map<string, Bucket>(), stage: new Map<string, Bucket>() };
		const add = (map: Map<string, Bucket>, k: string, b: Bucket) => {
			const t = map.get(k) ?? { requests: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, cost: 0 };
			t.requests += b.requests; t.prompt += b.prompt; t.completion += b.completion; t.cached += b.cached; t.reasoning += b.reasoning; t.cost += b.cost;
			map.set(k, t);
		};

		const daily = dates.map(date => {
			const byModel: Record<string, number> = {};
			let total = 0;
			for (const [key, b] of Object.entries(this.days[date] ?? {})) {
				const [model, stage, kind, id] = key.split(SEP);
				byModel[model] = (byModel[model] ?? 0) + b.cost;
				total += b.cost;
				totals.cost += b.cost; totals.requests += b.requests; totals.prompt += b.prompt; totals.completion += b.completion; totals.cached += b.cached;
				add(acc.model, model, b);
				add(acc.source, `${kind}${SEP}${id}`, b);
				add(acc.stage, stage, b);
			}
			return { date, total, byModel };
		});

		const rows = (map: Map<string, Bucket>, label: (k: string) => string): BreakdownRow[] => [...map.entries()]
			.map(([key, b]) => ({
				key,
				label: label(key),
				requests: b.requests,
				tokens: b.prompt + b.completion,
				cachedShare: b.prompt ? b.cached / b.prompt : 0,
				cost: b.cost,
				share: totals.cost ? b.cost / totals.cost : 0,
			}))
			.sort((a, b) => b.cost - a.cost || b.requests - a.requests);

		const since = now - days * 86_400_000;
		return {
			days,
			daily,
			totals,
			byModel: rows(acc.model, k => k),
			bySource: rows(acc.source, k => this.names[k] ?? k.split(SEP)[1]),
			byStage: rows(acc.stage, k => k),
			recent: this.recent.filter(e => e.at >= since),
		};
	}

	reset() {
		this.days = {};
		this.recent = [];
		this.scheduleSave();
	}

	private prune() {
		const cutoff = utcDay(Date.now() - RETENTION_DAYS * 86_400_000);
		for (const d of Object.keys(this.days)) { if (d < cutoff) { delete this.days[d]; } }
	}

	private scheduleSave() {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			void this.memento.update(STORAGE_KEY, { days: this.days, recent: this.recent, names: this.names });
		}, 1500);
	}
}

// --- Live activity -------------------------------------------------------------------------------

export type Phase = 'routing' | 'exploring' | 'drafting' | 'refining' | 'reviewing' | 'answering' | 'done' | 'error' | 'cancelled';
export type DraftState = 'pending' | 'ok' | 'failed' | 'dropped';

export interface LiveRun {
	id: string;
	source: Source;
	phase: Phase;
	detail?: string;
	startedAt: number;
	endedAt?: number;
	/** Model currently answering (final / explore / single). */
	model?: string;
	route?: { tier: string; target: string };
	drafts?: { model: string; state: DraftState; ms?: number }[];
	cost: number;
	requests: number;
}

/** Tracks what is running now. Finished runs stay visible briefly, and the last one is kept. */
export class ActivityBus {
	private readonly runs = new Map<string, LiveRun>();
	private last?: LiveRun;
	private seq = 0;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	constructor(ledger?: UsageLedger) {
		ledger?.onDidRecord(e => {
			const run = e.runId ? this.runs.get(e.runId) : undefined;
			if (run) { run.cost += e.cost; run.requests++; this.emitter.fire(); }
		});
	}

	start(source: Source): string {
		const id = `run-${Date.now().toString(36)}-${++this.seq}`;
		this.runs.set(id, { id, source, phase: 'answering', startedAt: Date.now(), cost: 0, requests: 0 });
		this.emitter.fire();
		return id;
	}

	update(id: string | undefined, patch: Partial<Omit<LiveRun, 'id'>>) {
		const run = id ? this.runs.get(id) : undefined;
		if (!run) { return; }
		Object.assign(run, patch);
		this.emitter.fire();
	}

	draft(id: string | undefined, index: number, state: DraftState, ms?: number) {
		const run = id ? this.runs.get(id) : undefined;
		if (!run?.drafts?.[index]) { return; }
		run.drafts[index] = { ...run.drafts[index], state, ms };
		this.emitter.fire();
	}

	end(id: string, phase: 'done' | 'error' | 'cancelled' = 'done') {
		const run = this.runs.get(id);
		if (!run) { return; }
		run.phase = phase;
		run.endedAt = Date.now();
		this.last = run;
		this.emitter.fire();
		setTimeout(() => { this.runs.delete(id); this.emitter.fire(); }, 4000);
	}

	snapshot(): { active: LiveRun[]; last?: LiveRun } {
		return { active: [...this.runs.values()].filter(r => !r.endedAt), last: this.last };
	}
}
