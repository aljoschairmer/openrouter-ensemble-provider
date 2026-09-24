import * as vscode from 'vscode';

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * How the drafting models work together.
 * - moa:     Mixture-of-Agents. Drafts are merged by the final model (Wang et al. 2024).
 * - council: Drafts are peer-reviewed with a rubric, own drafts excluded (Karpathy / amiable llm-council).
 * - judge:   One judge scores all drafts in a single call (GenSelect).
 * - plan:    Drafts are plans, not code; the final model refines and executes them (PlanSearch / CePO).
 */
export type Strategy = 'moa' | 'council' | 'judge' | 'plan';
export const STRATEGIES: readonly Strategy[] = ['moa', 'council', 'judge', 'plan'];

export interface ProposerSpec {
	model: string;
	/** Sampling temperature. Unset: automatic diversity when the same model appears several times. */
	temperature?: number;
	reasoning?: Effort;
	/** Optional perspective, e.g. "Focus on security and input validation". */
	role?: string;
}

/** Raw shape as stored in settings (proposers may be plain model ids). */
export interface EnsembleConfigRaw extends Omit<EnsembleConfig, 'proposers'> {
	proposers: (string | ProposerSpec)[];
}

export interface EnsembleConfig {
	id: string;
	name: string;
	strategy: Strategy;
	proposers: ProposerSpec[];
	aggregator: string;
	aggregatorReasoning?: Effort;
	/** Default reasoning effort for proposers without their own. */
	proposerReasoning?: Effort;
	/** Judge / critic model. Defaults to the aggregator. */
	judge?: string;
	/** Adds a critique of all drafts before the final answer (moa, plan). */
	critique: boolean;
	/** Second Mixture-of-Agents layer: every proposer revises its draft after seeing the others. */
	refine: boolean;
	proposerMaxTokens: number;
	/**
	 * When the drafts are made:
	 * - afterExploration: the final model first gathers context with read-only tools, then requests the drafts.
	 * - userTurns: at the start of each user message; tool steps reuse them.
	 * - always: on every request, including every tool step.
	 */
	trigger: Trigger;
	/** afterExploration: tool rounds after which drafts start even if the model hasn't asked for them. */
	maxExplorationSteps: number;
	/** Drafts needed before the grace period starts. Default: half of the proposers, rounded up. */
	quorum?: number;
	/** Seconds to wait for stragglers once the quorum is reached. */
	graceSeconds: number;
	/** Repeat the latest request at the end of the proposer prompt (RE2). */
	reread: boolean;
}

export type Trigger = 'afterExploration' | 'userTurns' | 'always';
export const TRIGGERS: readonly Trigger[] = ['afterExploration', 'userTurns', 'always'];

export type Tier = 'simple' | 'standard' | 'complex';
export const TIERS: readonly Tier[] = ['simple', 'standard', 'complex'];

export interface RouterConfig {
	id: string;
	name: string;
	/** Cheap, fast model that rates request difficulty. */
	classifier: string;
	/** Targets per tier: an OpenRouter model id, or `ensemble:<id>`. */
	simple: string;
	standard: string;
	complex: string;
	/** Use the classifier for ambiguous requests. Off: heuristics only (free, instant). */
	useClassifier: boolean;
}

export interface GeneralSettings {
	proposerTimeoutMs: number;
	proposerContextChars: number;
	logUsage: boolean;
	stickySessions: boolean;
	performanceMemory: boolean;
	modelReasoning: Record<string, Effort>;
	fallbacks: Record<string, string[]>;
}

export const ENSEMBLE_PREFIX = 'ensemble:';

export function cfg() {
	return vscode.workspace.getConfiguration('openrouterEnsemble');
}

const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

export function normalizeEnsemble(raw: EnsembleConfigRaw): EnsembleConfig {
	const proposers = (raw.proposers ?? [])
		.map(p => typeof p === 'string' ? { model: p } : { ...p })
		.filter(p => typeof p.model === 'string' && p.model.trim())
		.map(p => ({
			model: p.model.trim(),
			...(typeof p.temperature === 'number' ? { temperature: p.temperature } : {}),
			...(isEffort(p.reasoning) ? { reasoning: p.reasoning } : {}),
			...(p.role?.trim() ? { role: p.role.trim() } : {}),
		}));
	return {
		id: raw.id,
		name: raw.name,
		strategy: (STRATEGIES as readonly string[]).includes(raw.strategy) ? raw.strategy : 'moa',
		proposers,
		aggregator: raw.aggregator,
		aggregatorReasoning: isEffort(raw.aggregatorReasoning) ? raw.aggregatorReasoning : undefined,
		proposerReasoning: isEffort(raw.proposerReasoning) ? raw.proposerReasoning : undefined,
		judge: raw.judge?.trim() || undefined,
		critique: !!raw.critique,
		refine: !!raw.refine,
		proposerMaxTokens: raw.proposerMaxTokens ?? 4096,
		trigger: (TRIGGERS as readonly string[]).includes(raw.trigger) ? raw.trigger : 'userTurns',
		maxExplorationSteps: typeof raw.maxExplorationSteps === 'number' && raw.maxExplorationSteps >= 1 ? Math.floor(raw.maxExplorationSteps) : 4,
		quorum: typeof raw.quorum === 'number' && raw.quorum > 0 ? raw.quorum : undefined,
		graceSeconds: typeof raw.graceSeconds === 'number' && raw.graceSeconds >= 0 ? raw.graceSeconds : 10,
		reread: !!raw.reread,
	};
}

export function readEnsembles(): EnsembleConfig[] {
	return (cfg().get<EnsembleConfigRaw[]>('ensembles') ?? []).map(normalizeEnsemble);
}

export function readRouters(): RouterConfig[] {
	return (cfg().get<Partial<RouterConfig>[]>('routers') ?? [])
		.filter((r): r is RouterConfig => !!(r.id && r.name && r.simple && r.standard && r.complex))
		.map(r => ({ ...r, classifier: r.classifier || r.simple, useClassifier: r.useClassifier !== false }));
}

export function readGeneral(): GeneralSettings {
	const c = cfg();
	const modelReasoning: Record<string, Effort> = {};
	for (const [k, v] of Object.entries(c.get<Record<string, unknown>>('modelReasoning') ?? {})) {
		if (isEffort(v)) { modelReasoning[k] = v; }
	}
	const fallbacks: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(c.get<Record<string, unknown>>('fallbacks') ?? {})) {
		if (Array.isArray(v)) { fallbacks[k] = v.filter((x): x is string => typeof x === 'string' && !!x.trim()); }
	}
	return {
		proposerTimeoutMs: (c.get<number>('proposerTimeoutSeconds') ?? 90) * 1000,
		proposerContextChars: c.get<number>('proposerContextChars') ?? 120_000,
		logUsage: c.get<boolean>('logUsage') ?? true,
		stickySessions: c.get<boolean>('stickySessions') ?? true,
		performanceMemory: c.get<boolean>('performanceMemory') ?? true,
		modelReasoning,
		fallbacks,
	};
}

/** Quorum default: more than half of the drafts, so a single slow model never blocks the answer. */
export function effectiveQuorum(e: EnsembleConfig): number {
	const n = e.proposers.length;
	return Math.min(n, Math.max(1, e.quorum ?? Math.ceil(n / 2)));
}

/** Number of model calls per user message, used by the log and the settings page. */
export function callsPerMessage(e: EnsembleConfig): number {
	const n = e.proposers.length;
	let calls = n + 1;
	if (e.refine) { calls += n; }
	if (e.strategy === 'council' && n >= 2) { calls += n; }
	if (e.strategy === 'judge') { calls += 1; }
	if (e.critique && (e.strategy === 'moa' || e.strategy === 'plan')) { calls += 1; }
	return calls;
}
