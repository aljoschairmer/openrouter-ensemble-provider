import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import { ENSEMBLE_PREFIX, type EnsembleConfig, type GeneralSettings, type RouterConfig, type Tier } from './config';
import { isToolContinuation, lastUserText } from './convert';
import type { OpenRouterClient } from './openrouter';
import { CLASSIFIER } from './prompts';
import type { ModelRegistry } from './registry';
import type { CallMeta } from './usage';

export interface RouteDecision {
	tier: Tier;
	/** Model id or `ensemble:<id>`. */
	target: string;
	difficulty: number;
	source: 'heuristic' | 'classifier' | 'cached';
	note?: string;
}

// Signals adapted from switchboard's triage for a coding assistant
const CODE_RE = /```|\b(def|class|import|function|interface|const|let|SELECT|#include|public static)\b|=>|\w+\.(ts|tsx|js|py|go|rs|java|cs|cpp|rb|php|kt|swift)\b/;
const HARD_RE = /\b(architect\w*|design|refactor\w*|migrat\w*|optimi[sz]\w*|debug\w*|race condition|deadlock|concurren\w*|memory leak|security|vulnerab\w*|performance|scal\w*|trade-?offs?|edge cases?|root cause|across (the )?(codebase|repo|project)|multiple files|end-to-end|prove|algorithm)\b/gi;
const TRIVIAL_RE = /^(hi|hello|hey|thanks?|thank you|ok(ay)?|yes|no|danke|hallo)\b/i;

const TIER_ORDER: Tier[] = ['simple', 'standard', 'complex'];

/**
 * Picks a tier per user message. Cheap heuristics decide the obvious cases for free; a small LLM
 * classifier scores the ambiguous middle and is blended 50/50 with the heuristic prior (switchboard).
 * The decision sticks for all tool steps of that message, so an agent loop never switches models midway.
 */
export class Router {
	private readonly decisions = new Map<string, RouteDecision>();

	constructor(
		private readonly client: OpenRouterClient,
		private readonly registry: ModelRegistry,
		private readonly log: vscode.LogOutputChannel,
	) { }

	clear() { this.decisions.clear(); }

	async route(
		router: RouterConfig,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		ensembles: EnsembleConfig[],
		needs: { tools: boolean; images: boolean },
		settings: GeneralSettings,
		signal: AbortSignal,
		meta?: Omit<CallMeta, 'stage'>,
	): Promise<RouteDecision> {
		const raw = lastUserText(messages);
		const key = createHash('sha1').update(router.id).update('\0').update(raw).digest('hex');

		const cached = this.decisions.get(key);
		if (cached && isToolContinuation(messages)) {
			return { ...cached, source: 'cached' };
		}

		const request = extractUserRequest(raw);
		const turns = messages.filter(m => (m.role as number) === 1).length;
		const { prior, confident, note } = heuristic(request, raw, needs.tools, turns);

		let difficulty = prior;
		let source: RouteDecision['source'] = 'heuristic';
		if (!confident && router.useClassifier) {
			const llm = await this.classify(router, request, settings, signal, meta);
			if (llm !== undefined) {
				difficulty = 0.5 * llm + 0.5 * prior;
				source = 'classifier';
			}
		}

		const tier: Tier = difficulty <= 2.0 ? 'simple' : difficulty <= 3.4 ? 'standard' : 'complex';
		const decision = this.resolve(router, tier, ensembles, needs);
		const result: RouteDecision = { ...decision, difficulty, source, note };

		this.decisions.set(key, result);
		if (this.decisions.size > 64) { this.decisions.delete(this.decisions.keys().next().value!); }
		return result;
	}

	/** Maps a tier to its target, escalating when the target can't serve the request (tools, images, missing). */
	private resolve(router: RouterConfig, tier: Tier, ensembles: EnsembleConfig[], needs: { tools: boolean; images: boolean }) {
		for (let t = TIER_ORDER.indexOf(tier); t < TIER_ORDER.length; t++) {
			const target = router[TIER_ORDER[t]];
			const model = target.startsWith(ENSEMBLE_PREFIX)
				? ensembles.find(e => e.id === target.slice(ENSEMBLE_PREFIX.length))?.aggregator
				: target;
			if (!model) {
				this.log.warn(`[${router.id}] ${TIER_ORDER[t]} target "${target}" not found → escalating`);
				continue;
			}
			if (needs.tools && !this.registry.supportsTools(model)) { continue; }
			if (needs.images && !this.registry.supportsImages(model)) { continue; }
			return { tier: TIER_ORDER[t], target };
		}
		// Nothing fits the constraints: use the complex target anyway rather than failing
		return { tier: 'complex' as Tier, target: router.complex };
	}

	private async classify(router: RouterConfig, request: string, settings: GeneralSettings, signal: AbortSignal, meta?: Omit<CallMeta, 'stage'>): Promise<number | undefined> {
		const t0 = Date.now();
		try {
			const { text, usage } = await this.client.complete({
				...this.registry.params(router.classifier, { temperature: 0, maxTokens: 400, reasoning: 'none' }, settings),
				messages: [
					{ role: 'system', content: CLASSIFIER },
					{ role: 'user', content: `Request (${request.length} chars):\n${request.slice(0, 2500)}` },
				],
			}, AbortSignal.any([signal, AbortSignal.timeout(8000)]), meta && { ...meta, stage: 'classifier' });
			const m = text.match(/\{[\s\S]*?\}/);
			const d = m ? Number((JSON.parse(m[0]) as { difficulty?: unknown }).difficulty) : NaN;
			if (settings.logUsage && usage) {
				this.log.info(`[${router.id}] classifier ${router.classifier}: ${usage.prompt_tokens} in / ${usage.completion_tokens} out${usage.cost != null ? ` $${usage.cost.toFixed(5)}` : ''} (${Date.now() - t0} ms)`);
			}
			return Number.isFinite(d) ? Math.min(5, Math.max(1, d)) : undefined;
		} catch (err: any) {
			this.log.warn(`[${router.id}] classifier failed, using heuristics: ${err?.message ?? err}`);
			return undefined;
		}
	}
}

/**
 * Copilot wraps the typed request in <userRequest> next to large attachments and instructions.
 * Rating the whole message would make every agent request look huge, so rate the request itself.
 */
export function extractUserRequest(text: string): string {
	const m = text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/i);
	if (m) { return m[1]; }
	// Otherwise strip obvious context blocks
	return text.replace(/<(attachments?|context|editorContext|reminderInstructions|instructions)>[\s\S]*?<\/\1>/gi, '').trim() || text;
}

export function heuristic(request: string, raw: string, agentMode: boolean, turns: number): { prior: number; confident: boolean; note: string } {
	const n = request.length;
	const code = CODE_RE.test(request);
	const hard = (request.match(HARD_RE) ?? []).length;
	const attachments = raw.length - request.length > 2000;

	if (n < 60 && TRIVIAL_RE.test(request.trim()) && !code) {
		return { prior: 1.2, confident: true, note: 'trivial' };
	}
	if (hard >= 3 && (code || attachments || n > 600)) {
		return { prior: 4.6, confident: true, note: `${hard} hard signals` };
	}

	let prior = 2.0;
	prior += Math.min(n / 1200, 1.2);
	prior += 0.6 * Math.min(hard, 3);
	if (code) { prior += 0.4; }
	if (attachments) { prior += 0.3; }
	if (agentMode) { prior += 0.3; }
	if (turns > 6) { prior += 0.2; }
	return { prior: Math.min(5, Math.max(1, prior)), confident: false, note: `${hard} hard signals${code ? ', code' : ''}${agentMode ? ', agent' : ''}` };
}
