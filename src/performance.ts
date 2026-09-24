import type * as vscode from 'vscode';
import type { Strategy } from './config';

/**
 * Local memory of how each drafting model performs. Only numbers and model ids are stored
 * (in VS Code's globalState); prompts, drafts and answers never are.
 */

export interface DraftOutcome {
	model: string;
	index: number;
	/** ok: delivered · failed: error or timeout · dropped: cancelled after the quorum's grace period. */
	status: 'ok' | 'failed' | 'dropped';
	ms?: number;
	/** USD for all calls this model made in the turn (draft, revision, review). */
	cost?: number;
	/** Rubric score 1-10 (council / judge). */
	score?: number;
	/** Ranked first by the reviewers. */
	won?: boolean;
	/** Share of the final answer traceable to this draft (0..1), from content overlap. */
	adoption?: number;
}

export interface TurnRecord {
	key: string;
	ensembleId: string;
	strategy: Strategy;
	at: number;
	reviewed: boolean;
	drafts: DraftOutcome[];
	/** Share of the final answer found in any draft (0..1). */
	grounding?: number;
}

export type Confidence = 'insufficient' | 'preliminary' | 'solid';
export type Verdict = 'collecting' | 'strong' | 'fair' | 'weak' | 'slow' | 'unreliable';

export interface ModelStats {
	model: string;
	turns: number;
	delivered: number;
	failed: number;
	dropped: number;
	avgMs?: number;
	/** USD per turn for this model's calls. */
	avgCost?: number;
	/** This model's share of the drafting cost over the same turns (0..1). */
	costShare?: number;
	reviewedTurns: number;
	winRate?: number;
	avgScore?: number;
	adoptionTurns: number;
	avgAdoption?: number;
	/**
	 * Quality relative to a fair share: 1.0 = exactly its share (1/n of wins or adoption), 2.0 = twice that.
	 * Combines win rate (reviewed turns) and adoption (all turns with an answer).
	 */
	relativeQuality?: number;
	confidence: Confidence;
	verdict: Verdict;
	reason?: string;
}

const STORAGE_KEY = 'openrouterEnsemble.performance.v1';
const MAX_TURNS = 500;
const SHINGLE = 3;
const MIN_OUTPUT_SHINGLES = 25;

export function confidenceFor(n: number): Confidence {
	return n < 10 ? 'insufficient' : n < 30 ? 'preliminary' : 'solid';
}

export class PerformanceStore {
	private turns: TurnRecord[];
	/** In-memory only: draft shingles and accumulated final output per turn, for attribution. */
	private readonly live = new Map<string, { drafts: Set<string>[]; output: Set<string> }>();
	private saveTimer?: NodeJS.Timeout;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly memento: vscode.Memento, private readonly log?: vscode.LogOutputChannel) {
		const stored = memento.get<{ turns?: TurnRecord[] }>(STORAGE_KEY);
		this.turns = Array.isArray(stored?.turns) ? stored!.turns : [];
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	get size() { return this.turns.length; }

	/** Called by the pipeline after the drafting stages of one user message. */
	record(turn: TurnRecord, draftTexts: string[]) {
		const i = this.turns.findIndex(t => t.key === turn.key && t.ensembleId === turn.ensembleId);
		if (i >= 0) { this.turns[i] = turn; } else { this.turns.push(turn); }
		if (this.turns.length > MAX_TURNS) { this.turns.splice(0, this.turns.length - MAX_TURNS); }

		this.live.set(turn.key, { drafts: draftTexts.map(shingles), output: new Set() });
		if (this.live.size > 64) { this.live.delete(this.live.keys().next().value!); }
		this.changed();
	}

	/**
	 * Adds final-model output (answer text and edit arguments) for a turn and updates the attribution.
	 * Called after every request of the turn, so multi-step agent answers accumulate.
	 */
	addOutput(key: string, text: string) {
		const live = this.live.get(key);
		const turn = this.turns.find(t => t.key === key);
		if (!live || !turn || !text.trim()) { return; }
		for (const s of shingles(text)) { live.output.add(s); }
		if (live.output.size < MIN_OUTPUT_SHINGLES) { return; }

		const { shares, grounding } = attribute(live.output, live.drafts);
		turn.grounding = grounding;
		turn.drafts.forEach((d, i) => { d.adoption = d.status === 'ok' ? shares[i] : undefined; });
		this.changed();
	}

	reset(ensembleId?: string) {
		this.turns = ensembleId ? this.turns.filter(t => t.ensembleId !== ensembleId) : [];
		this.live.clear();
		this.changed();
	}

	/** Per-model statistics, for one ensemble or across all. */
	stats(ensembleId?: string): ModelStats[] {
		const turns = this.turns.filter(t => !ensembleId || t.ensembleId === ensembleId);
		const byModel = new Map<string, { rows: DraftOutcome[]; turns: TurnRecord[] }>();
		for (const t of turns) {
			for (const d of t.drafts) {
				const entry = byModel.get(d.model) ?? { rows: [], turns: [] };
				entry.rows.push(d);
				entry.turns.push(t);
				byModel.set(d.model, entry);
			}
		}

		return [...byModel.entries()].map(([model, { rows, turns: its }]) => {
			const n = rows.length;
			const delivered = rows.filter(r => r.status === 'ok');
			const ms = delivered.map(r => r.ms).filter((x): x is number => x !== undefined);
			const costs = rows.map(r => r.cost).filter((x): x is number => x !== undefined);

			// Cost share within the same turns
			let costShare: number | undefined;
			const turnCosts = its.map(t => t.drafts.reduce((s, d) => s + (d.cost ?? 0), 0));
			const total = turnCosts.reduce((a, b) => a + b, 0);
			if (total > 0 && costs.length) { costShare = costs.reduce((a, b) => a + b, 0) / total; }

			// Relative quality: each signal scaled by the number of drafts delivered in that turn
			const rel: number[] = [];
			let reviewedTurns = 0, wins = 0, scoreSum = 0, scored = 0, adoptionTurns = 0, adoptionSum = 0;
			rows.forEach((r, k) => {
				const t = its[k];
				const deliveredInTurn = t.drafts.filter(d => d.status === 'ok').length || 1;
				if (t.reviewed && r.status === 'ok' && r.score !== undefined) {
					reviewedTurns++;
					if (r.won) { wins++; }
					scoreSum += r.score;
					scored++;
					rel.push((r.won ? 1 : 0) * deliveredInTurn);
				}
				if (r.adoption !== undefined) {
					adoptionTurns++;
					adoptionSum += r.adoption;
					rel.push(r.adoption * deliveredInTurn);
				}
			});

			const stats: ModelStats = {
				model,
				turns: n,
				delivered: delivered.length,
				failed: rows.filter(r => r.status === 'failed').length,
				dropped: rows.filter(r => r.status === 'dropped').length,
				avgMs: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : undefined,
				avgCost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : undefined,
				costShare,
				reviewedTurns,
				winRate: reviewedTurns ? wins / reviewedTurns : undefined,
				avgScore: scored ? scoreSum / scored : undefined,
				adoptionTurns,
				avgAdoption: adoptionTurns ? adoptionSum / adoptionTurns : undefined,
				relativeQuality: rel.length ? rel.reduce((a, b) => a + b, 0) / rel.length : undefined,
				confidence: confidenceFor(n),
				verdict: 'collecting',
			};
			Object.assign(stats, verdictFor(stats));
			return stats;
		}).sort((a, b) => (b.relativeQuality ?? -1) - (a.relativeQuality ?? -1));
	}

	private changed() {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.memento.update(STORAGE_KEY, { turns: this.turns }).then(undefined, err => this.log?.warn(`Saving performance memory failed: ${err}`));
		}, 1000);
		this.listeners.forEach(l => l());
	}
}

/** Reliability problems first, then quality relative to the model's fair share. */
export function verdictFor(s: ModelStats): { verdict: Verdict; reason?: string } {
	if (s.confidence === 'insufficient') { return { verdict: 'collecting' }; }
	const failRate = s.failed / s.turns;
	const dropRate = s.dropped / s.turns;
	if (failRate > 0.2) { return { verdict: 'unreliable', reason: `fails in ${pct(failRate)} of messages` }; }
	if (dropRate > 0.3) { return { verdict: 'slow', reason: `misses the grace period in ${pct(dropRate)} of messages` }; }
	if (s.relativeQuality === undefined) { return { verdict: 'collecting' }; }
	if (s.relativeQuality < 0.5) {
		const cost = s.costShare !== undefined ? ` while taking ${pct(s.costShare)} of the drafting cost` : '';
		return { verdict: 'weak', reason: `contributes ${s.relativeQuality.toFixed(1)}× its fair share${cost}` };
	}
	if (s.relativeQuality >= 1.3) { return { verdict: 'strong', reason: `contributes ${s.relativeQuality.toFixed(1)}× its fair share` }; }
	return { verdict: 'fair' };
}

// --- Attribution ---------------------------------------------------------------------------------

/** Word 3-gram shingles; code and prose alike (identifiers and punctuation-free tokens). */
export function shingles(text: string): Set<string> {
	const tokens = text.toLowerCase().match(/[a-z0-9_$]+/g) ?? [];
	const out = new Set<string>();
	for (let i = 0; i + SHINGLE <= tokens.length && i < 30_000; i++) {
		out.add(tokens.slice(i, i + SHINGLE).join(' '));
	}
	return out;
}

/**
 * Each output shingle found in k drafts credits 1/k to each of them. Shares sum to 1 over the
 * grounded part of the answer; grounding says how much of the answer appears in any draft at all.
 */
export function attribute(output: Set<string>, drafts: Set<string>[]): { shares: number[]; grounding: number } {
	const credit = drafts.map(() => 0);
	let grounded = 0;
	for (const s of output) {
		const hits: number[] = [];
		drafts.forEach((d, i) => { if (d.has(s)) { hits.push(i); } });
		if (!hits.length) { continue; }
		grounded++;
		for (const i of hits) { credit[i] += 1 / hits.length; }
	}
	return {
		shares: credit.map(c => grounded ? c / grounded : 0),
		grounding: output.size ? grounded / output.size : 0,
	};
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
