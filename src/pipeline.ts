import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { effectiveQuorum, type EnsembleConfig, type GeneralSettings, type ProposerSpec } from './config';
import { flattenToTranscript, isToolContinuation, lastUserText } from './convert';
import type { OpenRouterClient, ORMessage, ORUsage } from './openrouter';
import * as P from './prompts';
import type { DraftOutcome, PerformanceStore } from './performance';
import type { CallOptions, ModelRegistry } from './registry';
import type { ActivityBus, Source, Stage } from './usage';

/** Who asked (ensemble or router) and which live run to report to. */
export interface RunOrigin {
	source: Source;
	runId?: string;
}

export interface Draft {
	/** Position in the configured proposer list. */
	index: number;
	model: string;
	text: string;
	/** Rubric score 1-10 after council / judge review. */
	score?: number;
	issues?: string[];
}

interface RunContext {
	origin: RunOrigin;
	/** Cost per model in this turn (drafts, revisions, reviews), for the performance memory. */
	costs: Map<string, number>;
	cfg: EnsembleConfig;
	settings: GeneralSettings;
	signal: AbortSignal;
	sessionId?: string;
	transcript: string;
	userText: string;
	progress: (message: string) => void;
}

interface ReviewOutcome {
	drafts: Draft[];
	/** Share of reviewers whose favourite equals the overall winner (0..1). */
	agreement?: number;
}

/** MARS-style temperature ladder for repeated models (Self-MoA needs diverse samples). */
const TEMPERATURE_LADDER = [0.3, 0.7, 1.0, 0.5, 0.9, 0.2, 0.8];

class Lru<V> {
	private readonly map = new Map<string, V>();
	constructor(private readonly max: number) { }
	get(k: string) { return this.map.get(k); }
	set(k: string, v: V) {
		this.map.delete(k);
		this.map.set(k, v);
		while (this.map.size > this.max) { this.map.delete(this.map.keys().next().value!); }
	}
	clear() { this.map.clear(); }
}

export class Pipeline {
	/** Final aggregator context per (ensemble, user message); null = no draft survived. */
	private readonly cache = new Lru<string | null>(32);
	/** afterExploration: turns where the model asked for drafts together with other tool calls. */
	private readonly ready = new Lru<true>(32);

	constructor(
		private readonly client: OpenRouterClient,
		private readonly registry: ModelRegistry,
		private readonly log: vscode.LogOutputChannel,
		private readonly perf?: PerformanceStore,
		private readonly bus?: ActivityBus,
	) { }

	clear() {
		this.cache.clear();
		this.ready.clear();
	}

	/** Identifies one user message for one ensemble configuration. */
	turnKey(cfg: EnsembleConfig, messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
		return createHash('sha1').update(JSON.stringify(cfg)).update('\0').update(lastUserText(messages)).digest('hex');
	}

	/** undefined: not drafted yet · null: drafted, but no draft survived · string: the aggregator context. */
	cached(key: string): string | null | undefined {
		return this.cache.get(key);
	}

	markReady(key: string) { this.ready.set(key, true); }
	isReady(key: string): boolean { return this.ready.get(key) === true; }

	/** Trigger userTurns / always: draft at the start of a user message (or every request). */
	async buildAggregatorContext(
		cfg: EnsembleConfig,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		settings: GeneralSettings,
		signal: AbortSignal,
		sessionId?: string,
		origin: RunOrigin = defaultOrigin(cfg),
	): Promise<string | undefined> {
		const key = this.turnKey(cfg, messages);
		if (cfg.trigger !== 'always' && isToolContinuation(messages)) {
			const cached = this.cache.get(key);
			if (cached !== undefined) {
				this.log.debug(`[${cfg.id}] tool step → reusing drafts of this message`);
				return cached ?? undefined;
			}
		}
		return this.run(cfg, messages, settings, signal, sessionId, key, origin);
	}

	/** Runs all stages on the conversation as it is now and caches the result under `key`. */
	async run(
		cfg: EnsembleConfig,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		settings: GeneralSettings,
		signal: AbortSignal,
		sessionId: string | undefined,
		key: string,
		origin: RunOrigin = defaultOrigin(cfg),
	): Promise<string | undefined> {
		const userText = lastUserText(messages);
		this.bus?.update(origin.runId, {
			phase: 'drafting',
			detail: undefined,
			drafts: cfg.proposers.map(p => ({ model: p.model, state: 'pending' as const })),
		});
		const block = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `$(sync~spin) ${cfg.name}` },
			async progress => {
				const ctx: RunContext = {
					cfg, settings, signal, sessionId, userText, origin,
					costs: new Map(),
					transcript: flattenToTranscript(messages, settings.proposerContextChars),
					progress: message => progress.report({ message }),
				};
				const started = Date.now();
				const outcomes: DraftOutcome[] = cfg.proposers.map((p, index) => ({ model: p.model, index, status: 'failed' }));

				let drafts = await this.propose(ctx, outcomes);
				if (signal.aborted) { throw new vscode.CancellationError(); }
				if (!drafts.length) {
					this.log.warn(`[${cfg.id}] no drafts arrived → final model answers alone`);
					this.record(ctx, key, outcomes, [], false);
					return null;
				}

				if (cfg.refine && drafts.length >= 2) {
					this.bus?.update(origin.runId, { phase: 'refining' });
					drafts = await this.refine(ctx, drafts);
				}

				let review: ReviewOutcome | undefined;
				if ((cfg.strategy === 'council' || cfg.strategy === 'judge') && drafts.length >= 2) {
					this.bus?.update(origin.runId, { phase: 'reviewing', detail: cfg.strategy === 'council' ? 'peer review' : 'judge' });
				}
				if (cfg.strategy === 'council' && drafts.length >= 2) {
					review = await this.council(ctx, drafts);
				} else if (cfg.strategy === 'judge' && drafts.length >= 2) {
					review = await this.judge(ctx, drafts);
				}

				let critique: string | undefined;
				if (cfg.critique && (cfg.strategy === 'moa' || cfg.strategy === 'plan')) {
					this.bus?.update(origin.runId, { phase: 'reviewing', detail: 'critique' });
					critique = await this.critique(ctx, drafts);
				}

				if (review) {
					const best = review.drafts[0];
					for (const d of review.drafts) {
						const o = outcomes[d.index];
						o.score = d.score;
						o.won = d === best && d.score !== undefined;
					}
				}
				this.record(ctx, key, outcomes, drafts, !!review);
				this.log.info(`[${cfg.id}] stages done in ${Date.now() - started} ms`);
				return render(cfg, review?.drafts ?? shuffle([...drafts]), !!review, review?.agreement, critique);
			},
		);

		this.cache.set(key, block);
		return block ?? undefined;
	}

	private record(ctx: RunContext, key: string, outcomes: DraftOutcome[], drafts: Draft[], reviewed: boolean) {
		if (!this.perf || !ctx.settings.performanceMemory) { return; }
		// Costs are per model; with repeated models, split them evenly across that model's rows
		for (const [model, cost] of ctx.costs) {
			const rows = outcomes.filter(o => o.model === model);
			rows.forEach(o => { o.cost = cost / rows.length; });
		}
		const texts = outcomes.map(o => drafts.find(d => d.index === o.index)?.text ?? '');
		this.perf.record({ key, ensembleId: ctx.cfg.id, strategy: ctx.cfg.strategy, at: Date.now(), reviewed, drafts: outcomes }, texts);
	}

	// --- Stage: propose ------------------------------------------------------------------------

	/**
	 * Fans out to all proposers. Once `quorum` drafts are in, stragglers get `graceSeconds` more;
	 * then they are cancelled. One slow model never holds the answer hostage.
	 */
	private propose(ctx: RunContext, outcomes: DraftOutcome[]): Promise<Draft[]> {
		const { cfg, settings } = ctx;
		const specs = cfg.proposers;
		const temps = diversify(specs);
		const quorum = effectiveQuorum(cfg);
		const system = cfg.strategy === 'plan' ? P.PROPOSER_PLAN : P.PROPOSER_ANSWER;
		const user = cfg.reread
			? `${ctx.transcript}\n\n### Read the latest request again\n${ctx.userText}`
			: ctx.transcript;

		return new Promise(resolve => {
			const drafts: Draft[] = [];
			const pending = new Set(specs.map((_, i) => i));
			const controllers = specs.map(() => new AbortController());
			let graceTimer: NodeJS.Timeout | undefined;
			let done = false;

			const finish = () => {
				if (done) { return; }
				done = true;
				clearTimeout(graceTimer);
				if (pending.size) {
					this.log.info(`[${cfg.id}] grace period over → dropping ${[...pending].map(i => specs[i].model).join(', ')}`);
				}
				controllers.forEach(c => c.abort());
				resolve(drafts.sort((a, b) => a.index - b.index));
			};
			const report = () => ctx.progress(`${drafts.length}/${specs.length} drafts · waiting: ${[...pending].map(i => short(specs[i].model)).join(', ')}`);

			ctx.signal.addEventListener('abort', finish, { once: true });
			report();

			specs.forEach((spec, i) => {
				const messages: ORMessage[] = [
					{ role: 'system', content: spec.role ? `${system}\n\nYour perspective: ${spec.role}` : system },
					{ role: 'user', content: user },
				];
				const t0 = Date.now();
				this.call(ctx, 'draft', `draft ${short(spec.model)}`, spec.model, messages, {
					temperature: temps[i],
					reasoning: spec.reasoning ?? cfg.proposerReasoning,
					maxTokens: cfg.proposerMaxTokens,
				}, controllers[i].signal)
					.then(text => {
						outcomes[i].ms = Date.now() - t0;
						if (text.trim()) {
							drafts.push({ index: i, model: spec.model, text: text.trim() });
							outcomes[i].status = 'ok';
						}
						this.bus?.draft(ctx.origin.runId, i, text.trim() ? 'ok' : 'failed', outcomes[i].ms);
					})
					.catch(err => {
						// Aborted by the grace period (not by the user) counts as "dropped"
						if (done && !ctx.signal.aborted) {
							outcomes[i].status = 'dropped';
							outcomes[i].ms = Date.now() - t0;
							this.bus?.draft(ctx.origin.runId, i, 'dropped', outcomes[i].ms);
							return;
						}
						this.bus?.draft(ctx.origin.runId, i, 'failed');
						this.log.warn(`[${cfg.id}] draft ${spec.model} failed: ${err?.message ?? err}`);
					})
					.finally(() => {
						pending.delete(i);
						if (done) { return; }
						report();
						if (!pending.size) { finish(); return; }
						if (drafts.length >= quorum && !graceTimer) {
							graceTimer = setTimeout(finish, cfg.graceSeconds * 1000);
						}
					});
			});
		});
	}

	// --- Stage: refine (second MoA layer) --------------------------------------------------------

	private async refine(ctx: RunContext, drafts: Draft[]): Promise<Draft[]> {
		const { cfg } = ctx;
		ctx.progress('drafts revising after seeing each other…');
		const system = `${cfg.strategy === 'plan' ? P.PROPOSER_PLAN : P.PROPOSER_ANSWER}\n\n${P.REFINE}`;

		const revised = await Promise.all(drafts.map(async d => {
			const others = drafts.filter(o => o !== d).map((o, i) => `<draft id="${i + 1}">\n${sandbox(o.text)}\n</draft>`).join('\n');
			const spec = cfg.proposers[d.index];
			try {
				const text = await this.call(ctx, 'refine', `refine ${short(d.model)}`, d.model, [
					{ role: 'system', content: system },
					{ role: 'user', content: `${ctx.transcript}\n\n<other_drafts>\n${others}\n</other_drafts>\n\n<your_draft>\n${sandbox(d.text)}\n</your_draft>` },
				], {
					temperature: spec?.temperature,
					reasoning: spec?.reasoning ?? cfg.proposerReasoning,
					maxTokens: cfg.proposerMaxTokens,
				});
				return text.trim() ? { ...d, text: text.trim() } : d;
			} catch (err: any) {
				this.log.warn(`[${cfg.id}] refine ${d.model} failed, keeping first draft: ${err?.message ?? err}`);
				return d;
			}
		}));
		return revised;
	}

	// --- Stage: council (peer review) ------------------------------------------------------------

	/**
	 * Every drafting model reviews the other models' drafts, anonymized and shuffled.
	 * Drafts written by the same model are excluded from its review (self-preference bias).
	 */
	private async council(ctx: RunContext, drafts: Draft[]): Promise<ReviewOutcome> {
		const { cfg } = ctx;
		const reviewers = uniqueBy(drafts, d => d.model).map(d => d.model);
		const canReview = reviewers.some(r => drafts.some(d => d.model !== r));
		if (!canReview) {
			this.log.info(`[${cfg.id}] all drafts come from one model → judge instead of peer review`);
			return this.judge(ctx, drafts);
		}
		ctx.progress(`peer review by ${reviewers.length} models…`);

		const collected = drafts.map(() => [] as ReviewEntry[]);
		const favourites: number[] = [];

		await Promise.allSettled(reviewers.map(async reviewer => {
			const pool = drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.model !== reviewer);
			const shown = shuffle(pool);
			const labels = shown.map((_, k) => label(k));
			const body = shown.map(({ d }, k) => `<candidate id="${labels[k]}">\n${sandbox(d.text)}\n</candidate>`).join('\n\n');

			const text = await this.call(ctx, 'review', `review ${short(reviewer)}`, reviewer, [
				{ role: 'system', content: P.REVIEW },
				{ role: 'user', content: `<request>\n${ctx.userText}\n</request>\n\n${body}` },
			], { temperature: 0, maxTokens: 3000, reasoning: cfg.proposerReasoning ?? 'low' });

			const parsed = parseReview(text, labels);
			for (const r of parsed.reviews) {
				collected[shown[labels.indexOf(r.id)].i].push(r);
			}
			if (parsed.best) { favourites.push(shown[labels.indexOf(parsed.best)].i); }
		}));

		return this.scoreDrafts(cfg, drafts, collected, favourites);
	}

	// --- Stage: judge (GenSelect) ----------------------------------------------------------------

	private async judge(ctx: RunContext, drafts: Draft[]): Promise<ReviewOutcome> {
		const { cfg } = ctx;
		const judge = cfg.judge ?? cfg.aggregator;
		ctx.progress(`${short(judge)} judging ${drafts.length} drafts…`);

		const shown = shuffle(drafts.map((d, i) => ({ d, i })));
		const labels = shown.map((_, k) => label(k));
		const body = shown.map(({ d }, k) => `<candidate id="${labels[k]}">\n${sandbox(d.text)}\n</candidate>`).join('\n\n');
		const collected = drafts.map(() => [] as ReviewEntry[]);
		const favourites: number[] = [];

		try {
			const text = await this.call(ctx, 'judge', `judge ${short(judge)}`, judge, [
				{ role: 'system', content: P.REVIEW },
				{ role: 'user', content: `<request>\n${ctx.userText}\n</request>\n\n${body}` },
			], { temperature: 0, maxTokens: 4000, reasoning: 'medium' });
			const parsed = parseReview(text, labels);
			for (const r of parsed.reviews) { collected[shown[labels.indexOf(r.id)].i].push(r); }
			if (parsed.best) { favourites.push(shown[labels.indexOf(parsed.best)].i); }
		} catch (err: any) {
			this.log.warn(`[${cfg.id}] judge failed, drafts stay unranked: ${err?.message ?? err}`);
			return { drafts: shuffle([...drafts]) };
		}
		return this.scoreDrafts(cfg, drafts, collected, favourites);
	}

	private scoreDrafts(cfg: EnsembleConfig, drafts: Draft[], collected: ReviewEntry[][], favourites: number[]): ReviewOutcome {
		const scored = drafts.map((d, i) => {
			const entries = collected[i];
			const score = entries.length ? entries.reduce((s, r) => s + rubricScore(r), 0) / entries.length : undefined;
			const issues = entries.map(r => r.issue).filter(x => x && !/^none\.?$/i.test(x));
			return { ...d, score, issues };
		});
		const ranked = [...scored].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
		const winner = drafts.indexOf(drafts.find(d => d.index === ranked[0].index)!);
		const agreement = favourites.length ? favourites.filter(f => f === winner).length / favourites.length : undefined;

		this.log.info(`[${cfg.id}] scores: ${ranked.map(d => `${short(d.model)}=${d.score?.toFixed(1) ?? '–'}`).join(', ')}`
			+ (agreement !== undefined ? ` · agreement ${(agreement * 100).toFixed(0)}%` : ''));
		return { drafts: ranked, agreement };
	}

	// --- Stage: critique -------------------------------------------------------------------------

	private async critique(ctx: RunContext, drafts: Draft[]): Promise<string | undefined> {
		const { cfg } = ctx;
		const critic = cfg.judge ?? cfg.aggregator;
		ctx.progress(`${short(critic)} critiquing drafts…`);
		const body = drafts.map((d, k) => `<draft id="${k + 1}">\n${sandbox(d.text)}\n</draft>`).join('\n\n');
		try {
			const text = await this.call(ctx, 'critique', `critique ${short(critic)}`, critic, [
				{ role: 'system', content: P.CRITIQUE },
				{ role: 'user', content: `<request>\n${ctx.userText}\n</request>\n\n${body}` },
			], { temperature: 0.1, maxTokens: 4000, reasoning: 'medium' });
			return text.trim() || undefined;
		} catch (err: any) {
			this.log.warn(`[${cfg.id}] critique failed: ${err?.message ?? err}`);
			return undefined;
		}
	}

	// --- Shared ----------------------------------------------------------------------------------

	private async call(
		ctx: RunContext,
		stage: Stage,
		what: string,
		model: string,
		messages: ORMessage[],
		opts: Omit<CallOptions, 'sessionId'>,
		extraSignal?: AbortSignal,
	): Promise<string> {
		const signals = [ctx.signal, AbortSignal.timeout(ctx.settings.proposerTimeoutMs)];
		if (extraSignal) { signals.push(extraSignal); }
		const t0 = Date.now();
		const { text, usage } = await this.client.complete({
			...this.registry.params(model, { ...opts, sessionId: ctx.sessionId }, ctx.settings),
			messages,
		}, AbortSignal.any(signals), { stage, source: ctx.origin.source, runId: ctx.origin.runId });
		this.logUsage(ctx.settings, `${ctx.cfg.id} ${what}`, usage, Date.now() - t0);
		if (usage?.cost != null) { ctx.costs.set(model, (ctx.costs.get(model) ?? 0) + usage.cost); }
		return text;
	}

	private logUsage(settings: GeneralSettings, label: string, usage: ORUsage | undefined, ms: number) {
		if (!settings.logUsage || !usage) { return; }
		const cost = usage.cost != null ? ` $${usage.cost.toFixed(5)}` : '';
		this.log.info(`${label}: ${usage.prompt_tokens} in / ${usage.completion_tokens} out${cost} (${ms} ms)`);
	}
}

// ------------------------------------------------------------------------------------------------

/** Calls are attributed to the ensemble itself unless the caller says otherwise. */
const defaultOrigin = (cfg: EnsembleConfig): RunOrigin => ({ source: { kind: 'ensemble', id: cfg.id, name: cfg.name } });

interface ReviewEntry {
	id: string;
	correctness: number;
	completeness: number;
	clarity: number;
	issue: string;
}

/**
 * Correctness-weighted rubric with an accuracy ceiling (amiable llm-council ADR-016):
 * a well-written but wrong answer can't outrank a correct one.
 */
export function rubricScore(r: Pick<ReviewEntry, 'correctness' | 'completeness' | 'clarity'>): number {
	const c = clamp(r.correctness), m = clamp(r.completeness), l = clamp(r.clarity);
	let score = 0.5 * c + 0.25 * m + 0.25 * l;
	if (c < 5) { score = Math.min(score, 4); } else if (c < 7) { score = Math.min(score, 7); }
	return score;
}

export function parseReview(text: string, labels: string[]): { reviews: ReviewEntry[]; best?: string } {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) { return { reviews: [] }; }
	try {
		const obj = JSON.parse(match[0]) as { reviews?: unknown[]; best?: unknown };
		const seen = new Set<string>();
		const reviews: ReviewEntry[] = [];
		for (const raw of obj.reviews ?? []) {
			const r = raw as Record<string, unknown>;
			const id = String(r.id ?? '').trim().toUpperCase();
			if (!labels.includes(id) || seen.has(id)) { continue; }
			seen.add(id);
			reviews.push({
				id,
				correctness: Number(r.correctness),
				completeness: Number(r.completeness),
				clarity: Number(r.clarity),
				issue: String(r.issue ?? '').trim(),
			});
		}
		const best = String(obj.best ?? '').trim().toUpperCase();
		return { reviews, best: labels.includes(best) ? best : undefined };
	} catch {
		return { reviews: [] };
	}
}

function render(cfg: EnsembleConfig, drafts: Draft[], reviewed: boolean, agreement?: number, critique?: string): string {
	const parts = [cfg.strategy === 'plan' ? P.AGGREGATOR_PLAN : P.AGGREGATOR_BASE];
	if (reviewed) {
		parts.push('The drafts were scored by independent reviewers (1-10, correctness-weighted) and are ordered best first. Reviewer issues are listed per draft; check them.');
		if (agreement !== undefined && agreement < 0.5) {
			parts.push('Reviewers disagreed about which draft is best. Decide on the merits and verify the disputed points yourself.');
		}
	}
	const body = drafts.map((d, k) => {
		const attrs = reviewed && d.score !== undefined ? ` id="${k + 1}" score="${d.score.toFixed(1)}"` : ` id="${k + 1}"`;
		const issues = d.issues?.length ? `\n<reviewer_issues>\n${d.issues.map(i => `- ${sandbox(i)}`).join('\n')}\n</reviewer_issues>` : '';
		return `<draft${attrs}>\n${sandbox(d.text)}${issues}\n</draft>`;
	});
	parts.push(`<drafts>\n${body.join('\n\n')}\n</drafts>`);
	if (critique) {
		parts.push(`A reviewer critiqued the drafts:\n<critique>\n${sandbox(critique)}\n</critique>`);
	}
	return parts.join('\n\n');
}

/** Neutralizes tags that could break out of the XML sandbox (prompt injection via drafts). */
export function sandbox(text: string): string {
	return text.replace(/<(\/?)(drafts?|critique|reviewer_issues|candidate|request|other_drafts|your_draft)\b/gi, '&lt;$1$2');
}

/** Temperatures for repeated models, so Self-MoA samples actually differ. */
export function diversify(specs: ProposerSpec[]): (number | undefined)[] {
	const seen = new Map<string, number>();
	const counts = new Map<string, number>();
	specs.forEach(s => counts.set(s.model, (counts.get(s.model) ?? 0) + 1));
	return specs.map(s => {
		if (s.temperature !== undefined) { return s.temperature; }
		if ((counts.get(s.model) ?? 0) < 2) { return undefined; }
		const k = seen.get(s.model) ?? 0;
		seen.set(s.model, k + 1);
		return TEMPERATURE_LADDER[k % TEMPERATURE_LADDER.length];
	});
}

const clamp = (n: number) => Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 5;
const label = (k: number) => String.fromCharCode(65 + k);
const short = (id: string) => id.replace(/^~/, '').split('/').pop() ?? id;

function shuffle<T>(arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

function uniqueBy<T>(arr: T[], key: (t: T) => string): T[] {
	const seen = new Set<string>();
	return arr.filter(x => !seen.has(key(x)) && !!seen.add(key(x)));
}
