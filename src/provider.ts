import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
	callsPerMessage, cfg, ENSEMBLE_PREFIX, readEnsembles, readGeneral, readRouters,
	type Effort, type EnsembleConfig, type GeneralSettings, type RouterConfig,
} from './config';
import { estimateTokens, toOpenRouterMessages, toOpenRouterTools } from './convert';
import { OpenRouterClient, OpenRouterError, type ORModel } from './openrouter';
import { Pipeline } from './pipeline';
import { PerformanceStore } from './performance';
import * as P from './prompts';
import { ModelRegistry } from './registry';
import { classifyTool, DRAFTS_TOOL, DRAFTS_TOOL_NAME, explorationRounds } from './tools';
import { Router } from './router';
import type { ActivityBus, Source, Stage, UsageLedger } from './usage';

type ORMessages = ReturnType<typeof toOpenRouterMessages>;

/** What the final model produced in one streamed request. */
interface StreamResult {
	/** Answer text plus arguments of non-read tool calls (edits), for attribution. */
	output: string;
	text: string;
	reportedToolCalls: number;
	/** The internal handoff call, if the model made it (never reported to VS Code). */
	draftsRequest?: { id: string };
}

type ModelInfo = vscode.LanguageModelChatInformation & (
	| { kind: 'single'; orId: string }
	| { kind: 'ensemble'; ensemble: EnsembleConfig }
	| { kind: 'router'; router: RouterConfig }
);

export const SECRET_KEY = 'openrouterEnsemble.apiKey';
/** Optional management key: account-wide activity and credit balance for the sidebar. Never used for inference. */
export const MANAGEMENT_KEY = 'openrouterEnsemble.managementKey';
const MODEL_CACHE_TTL = 10 * 60 * 1000;
const OUTPUT_CAP = 32_000;

export class OpenRouterEnsembleProvider implements vscode.LanguageModelChatProvider<ModelInfo> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	readonly client: OpenRouterClient;
	readonly registry = new ModelRegistry();
	private readonly pipeline: Pipeline;
	private readonly router: Router;
	private modelCache?: { at: number; models: ORModel[] };

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly log: vscode.LogOutputChannel,
		readonly perf?: PerformanceStore,
		readonly ledger?: UsageLedger,
		readonly bus?: ActivityBus,
	) {
		this.client = new OpenRouterClient(
			async () => this.secrets.get(SECRET_KEY),
			() => cfg().get<Record<string, unknown>>('extraBody') ?? {},
			log,
		);
		if (ledger) { this.client.onUsage = e => ledger.record(e); }
		this.pipeline = new Pipeline(this.client, this.registry, log, perf, bus);
		this.router = new Router(this.client, this.registry, log);
	}

	/** Called on config / key changes so VS Code re-queries the model list. */
	refresh() {
		this.modelCache = undefined;
		this.pipeline.clear();
		this.router.clear();
		this.changeEmitter.fire();
	}

	async setApiKey(): Promise<boolean> {
		const key = await vscode.window.showInputBox({
			title: 'OpenRouter API Key',
			prompt: 'Create one at https://openrouter.ai/settings/keys',
			password: true,
			ignoreFocusOut: true,
			validateInput: v => v.trim().startsWith('sk-or-') ? undefined : 'OpenRouter keys start with "sk-or-"',
		});
		if (!key) { return false; }
		try {
			await this.storeApiKey(key);
			return true;
		} catch (err) {
			void vscode.window.showErrorMessage(`OpenRouter rejected this key: ${errorMessage(err)}`);
			return false;
		}
	}

	async hasApiKey(): Promise<boolean> {
		return !!await this.secrets.get(SECRET_KEY);
	}

	/** Validates the key against OpenRouter before storing it. Throws if it is rejected. */
	async storeApiKey(key: string) {
		const info = await this.client.getKeyInfo(key.trim());
		await this.secrets.store(SECRET_KEY, key.trim());
		this.refresh();
		return info;
	}

	async getManagementKey(): Promise<string | undefined> {
		return this.secrets.get(MANAGEMENT_KEY);
	}

	/** Validates against /credits (which requires a management key) before storing. */
	async storeManagementKey(key: string) {
		const credits = await this.client.getCredits(key.trim());
		await this.secrets.store(MANAGEMENT_KEY, key.trim());
		return credits;
	}

	async clearManagementKey() {
		await this.secrets.delete(MANAGEMENT_KEY);
	}

	async clearApiKey() {
		await this.secrets.delete(SECRET_KEY);
		this.refresh();
	}

	// ---------------------------------------------------------------------------------------------
	// LanguageModelChatProvider
	// ---------------------------------------------------------------------------------------------

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<ModelInfo[]> {
		if (!await this.secrets.get(SECRET_KEY)) {
			if (options.silent || !await this.setApiKey()) {
				return [];
			}
		}

		let models: ORModel[];
		try {
			models = await this.getCatalog();
		} catch (err) {
			this.log.error(`Fetching OpenRouter models failed: ${errorMessage(err)}`);
			return [];
		}
		const byId = new Map(models.map(m => [m.id, m]));
		const ensembles = readEnsembles();
		const result: ModelInfo[] = [];

		// 1) Routers ("Auto"): pick a single model or an ensemble per message
		for (const router of readRouters()) {
			const targets = [router.simple, router.standard, router.complex]
				.map(t => this.targetModel(t, ensembles))
				.map(id => id && byId.get(id))
				.filter((m): m is ORModel => !!m);
			if (!targets.length) {
				this.log.warn(`Router "${router.id}": none of its targets exist → skipped`);
				continue;
			}
			const limits = targets.map(modelLimits);
			result.push({
				kind: 'router',
				router,
				id: `router:${router.id}`,
				name: router.name,
				family: 'openrouter-router',
				version: '1',
				detail: [router.simple, router.standard, router.complex].map(t => shortName(t)).join(' · '),
				tooltip: `Routes each message by difficulty\nSimple: ${router.simple}\nStandard: ${router.standard}\nComplex: ${router.complex}\nClassifier: ${router.useClassifier ? router.classifier : 'heuristics only'}`,
				maxInputTokens: Math.min(...limits.map(l => l.maxInputTokens)),
				maxOutputTokens: Math.min(...limits.map(l => l.maxOutputTokens)),
				capabilities: {
					toolCalling: targets.some(supportsTools),
					imageInput: targets.some(supportsImages),
				},
			});
		}

		// 2) Ensembles
		for (const ens of ensembles) {
			const aggregator = byId.get(ens.aggregator);
			if (!aggregator) {
				this.log.warn(`Ensemble "${ens.id}": final model ${ens.aggregator} not found on OpenRouter → skipped`);
				continue;
			}
			ens.proposers.forEach(p => { if (!byId.has(p.model)) { this.log.warn(`Ensemble "${ens.id}": drafting model ${p.model} not found`); } });

			result.push({
				kind: 'ensemble',
				ensemble: ens,
				id: `ensemble:${ens.id}`,
				name: ens.name,
				family: 'openrouter-ensemble',
				version: '1',
				detail: `${ens.proposers.length}× → ${shortName(ens.aggregator)}`,
				tooltip: `${STRATEGY_LABEL[ens.strategy]} · ${callsPerMessage(ens)} calls per message\nDrafting: ${ens.proposers.map(p => p.model).join(', ')}\nFinal: ${ens.aggregator}`,
				...modelLimits(aggregator),
				capabilities: {
					toolCalling: supportsTools(aggregator),
					imageInput: supportsImages(aggregator),
				},
			});
		}

		// 3) Single pass-through models
		const wanted = cfg().get<string[]>('models') ?? [];
		const singles = wanted.includes('*')
			? models.filter(m => isChatModel(m) && supportsTools(m))
			: wanted.map(id => byId.get(id)).filter((m): m is ORModel => !!m);
		for (const m of singles) {
			result.push({
				kind: 'single',
				orId: m.id,
				id: m.id,
				name: m.name,
				family: m.id.replace(/^~/, '').split('/')[0],
				version: m.id,
				detail: 'OpenRouter',
				tooltip: m.id,
				...modelLimits(m),
				capabilities: { toolCalling: supportsTools(m), imageInput: supportsImages(m) },
			});
		}
		return result;
	}

	async provideLanguageModelChatResponse(
		model: ModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const abort = new AbortController();
		const sub = token.onCancellationRequested(() => abort.abort());
		const settings = readGeneral();
		const sessionId = conversationId(messages);
		const requestSource: Source = model.kind === 'router' ? { kind: 'router', id: model.router.id, name: model.router.name }
			: model.kind === 'ensemble' ? { kind: 'ensemble', id: model.ensemble.id, name: model.ensemble.name }
			: { kind: 'single', id: model.orId, name: model.name };
		const runId = this.bus?.start(requestSource);
		let outcome: 'done' | 'error' | 'cancelled' = 'done';

		try {
			// Keep capability data fresh for parameter filtering (cached, usually free)
			await this.getCatalog().catch(() => undefined);

			let target: { kind: 'single'; model: string } | { kind: 'ensemble'; ensemble: EnsembleConfig };
			if (model.kind === 'router') {
				const ensembles = readEnsembles();
				this.bus?.update(runId, { phase: 'routing' });
				const decision = await this.router.route(model.router, messages, ensembles, {
					tools: !!options.tools?.length,
					images: hasImages(messages),
				}, settings, abort.signal, { source: requestSource, runId });
				const routedEnsemble = decision.target.startsWith(ENSEMBLE_PREFIX)
					? ensembles.find(e => e.id === decision.target.slice(ENSEMBLE_PREFIX.length))
					: undefined;
				this.bus?.update(runId, { route: { tier: decision.tier, target: routedEnsemble?.name ?? decision.target } });
				if (decision.source !== 'cached') {
					this.log.info(`[${model.router.id}] ${decision.tier} (difficulty ${decision.difficulty.toFixed(1)}, ${decision.source}${decision.note ? `, ${decision.note}` : ''}) → ${decision.target}`);
					vscode.window.setStatusBarMessage(`$(arrow-swap) ${model.router.name}: ${decision.tier} → ${shortName(decision.target)}`, 10_000);
				}
				const ens = decision.target.startsWith(ENSEMBLE_PREFIX)
					? ensembles.find(e => e.id === decision.target.slice(ENSEMBLE_PREFIX.length))
					: undefined;
				target = ens ? { kind: 'ensemble', ensemble: ens } : { kind: 'single', model: decision.target };
			} else if (model.kind === 'ensemble') {
				target = { kind: 'ensemble', ensemble: model.ensemble };
			} else {
				target = { kind: 'single', model: model.orId };
			}

			// Ensemble calls are attributed to the ensemble (also when a router picked it), single models to the request's source
			const source: Source = target.kind === 'ensemble'
				? { kind: 'ensemble', id: target.ensemble.id, name: target.ensemble.name }
				: requestSource;
			const run: RunOptions = { options, progress, token, signal: abort.signal, settings, sessionId, maxOutputTokens: model.maxOutputTokens, source, runId };
			if (target.kind === 'single') {
				const orMessages = toOpenRouterMessages(messages, { images: this.registry.supportsImages(target.model) });
				this.bus?.update(runId, { phase: 'answering', model: target.model });
				await this.streamTo(target.model, orMessages, options.tools, run, { label: '', stage: 'single' });
				return;
			}

			const ens = target.ensemble;
			const orMessages = toOpenRouterMessages(messages, { images: this.registry.supportsImages(ens.aggregator) });
			if (ens.trigger === 'afterExploration') {
				await this.respondWithExploration(ens, messages, orMessages, run);
			} else {
				const key = this.pipeline.turnKey(ens, messages);
				const block = await this.pipeline.buildAggregatorContext(ens, messages, settings, abort.signal, sessionId, { source, runId });
				this.bus?.update(runId, { phase: 'answering', model: ens.aggregator });
				const result = await this.streamTo(ens.aggregator, block ? injectSystem(orMessages, block) : orMessages, options.tools, run, {
					label: 'final ', stage: 'final', reasoning: ens.aggregatorReasoning,
				});
				this.perf?.addOutput(key, result.output);
			}
		} catch (err) {
			if (token.isCancellationRequested || (err as Error)?.name === 'AbortError' || err instanceof vscode.CancellationError) {
				outcome = 'cancelled';
				return;
			}
			outcome = 'error';
			this.bus?.update(runId, { detail: errorMessage(err) });
			this.log.error(errorMessage(err));
			if (err instanceof OpenRouterError && err.status === 401) {
				void vscode.window.showErrorMessage('OpenRouter rejected the API key.', 'Open Settings')
					.then(choice => choice && vscode.commands.executeCommand('openrouterEnsemble.manage'));
			}
			throw err;
		} finally {
			sub.dispose();
			if (runId) { this.bus?.end(runId, outcome); }
		}
	}

	/**
	 * Two-phase answer for trigger "afterExploration":
	 * 1. The final model explores with read-only tools and calls request_expert_drafts when it has enough context.
	 * 2. Drafts are made from the conversation as it is then (memory, files, search results included),
	 *    and the final model continues with the full toolset. Editing before the drafts is impossible.
	 */
	private async respondWithExploration(
		ens: EnsembleConfig,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		orMessages: ORMessages,
		run: RunOptions,
	) {
		const key = this.pipeline.turnKey(ens, messages);
		const tools = run.options.tools ?? [];
		const readOnly = tools.filter(t => classifyTool(t.name) === 'read');
		const rounds = explorationRounds(messages);

		if (rounds === 0) {
			this.log.debug(`[${ens.id}] tools offered: ${tools.map(t => `${t.name}(${classifyTool(t.name)})`).join(', ') || 'none'}`);
		}

		let drafted = this.pipeline.cached(key);
		if (drafted === undefined) {
			const reason = !tools.length ? 'no tools (ask mode)'
				: !readOnly.length ? 'no read-only tools'
				: this.pipeline.isReady(key) ? 'model requested drafts'
				: rounds >= ens.maxExplorationSteps ? `exploration limit (${rounds} rounds)`
				: undefined;
			if (reason) {
				this.log.info(`[${ens.id}] drafting now: ${reason}`);
				drafted = (await this.pipeline.run(ens, messages, run.settings, run.signal, run.sessionId, key, { source: run.source, runId: run.runId })) ?? null;
			}
		}

		// Phase 2 (or later tool steps of this message): drafts in context, full toolset
		if (drafted !== undefined) {
			this.bus?.update(run.runId, { phase: 'answering', model: ens.aggregator });
			const result = await this.streamTo(ens.aggregator, drafted ? injectSystem(orMessages, drafted) : orMessages, tools, run, {
				label: 'final ', stage: 'final', reasoning: ens.aggregatorReasoning,
			});
			this.perf?.addOutput(key, result.output);
			return;
		}

		// Phase 1: explore with read-only tools plus the handoff tool
		this.log.info(`[${ens.id}] exploring (round ${rounds + 1}/${ens.maxExplorationSteps}, ${readOnly.length} of ${tools.length} tools)`);
		this.bus?.update(run.runId, { phase: 'exploring', model: ens.aggregator, detail: `round ${rounds + 1} of ${ens.maxExplorationSteps}` });
		const explore = await this.streamTo(ens.aggregator, injectSystem(orMessages, P.EXPLORE), [...readOnly, DRAFTS_TOOL], run, {
			label: 'explore ', stage: 'explore', reasoning: ens.aggregatorReasoning, interceptDraftsTool: true,
		});
		if (!explore.draftsRequest) {
			return; // answered directly, or VS Code runs the read tools and calls us again
		}
		if (explore.reportedToolCalls > 0) {
			// Asked for drafts alongside real reads: draft on the next step, once those results are in
			this.pipeline.markReady(key);
			return;
		}

		// Asked for drafts alone: draft now and continue in the same response, so the turn doesn't end
		this.log.info(`[${ens.id}] model requested drafts after ${rounds} tool round(s)`);
		const block = await this.pipeline.run(ens, messages, run.settings, run.signal, run.sessionId, key, { source: run.source, runId: run.runId });
		this.bus?.update(run.runId, { phase: 'answering', model: ens.aggregator });
		const handoff: ORMessages = [
			...orMessages,
			{
				role: 'assistant',
				content: explore.text || null,
				tool_calls: [{ id: explore.draftsRequest.id, type: 'function', function: { name: DRAFTS_TOOL_NAME, arguments: '{}' } }],
			},
			{ role: 'tool', tool_call_id: explore.draftsRequest.id, content: P.DRAFTS_DELIVERED },
		];
		// The handoff tool stays declared so the history above is valid for every provider; calling it again is ignored
		const result = await this.streamTo(ens.aggregator, block ? injectSystem(handoff, block) : handoff, [...tools, DRAFTS_TOOL], run, {
			label: 'final ', stage: 'final', reasoning: ens.aggregatorReasoning, interceptDraftsTool: true,
		});
		this.perf?.addOutput(key, explore.output + '\n' + result.output);
	}

	private async streamTo(
		model: string,
		messages: ORMessages,
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		run: RunOptions,
		opts: { label: string; stage: Stage; reasoning?: Effort; interceptDraftsTool?: boolean },
	): Promise<StreamResult> {
		const { options, progress, token, signal, settings } = run;
		const orTools = toOpenRouterTools(tools);
		const limits = this.registry.get(model) ? modelLimits(this.registry.get(model)!) : { maxOutputTokens: run.maxOutputTokens };
		const result: StreamResult = { output: '', text: '', reportedToolCalls: 0 };
		const t0 = Date.now();

		for await (const ev of this.client.stream({
			...this.registry.params(model, {
				maxTokens: Math.min(limits.maxOutputTokens, run.maxOutputTokens || limits.maxOutputTokens),
				reasoning: opts.reasoning,
				sessionId: run.sessionId,
			}, settings),
			messages,
			...(orTools ? { tools: orTools, tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' as const : 'auto' as const } : {}),
			...(options.modelOptions ?? {}),
		}, signal, { stage: opts.stage, source: run.source, runId: run.runId })) {
			if (token.isCancellationRequested) { break; }
			switch (ev.type) {
				case 'text':
					result.text += ev.text;
					result.output += ev.text;
					progress.report(new vscode.LanguageModelTextPart(ev.text));
					break;
				case 'toolCall':
					if (ev.name === DRAFTS_TOOL_NAME) {
						if (opts.interceptDraftsTool && !result.draftsRequest) { result.draftsRequest = { id: ev.id }; }
						break; // internal: never reported to VS Code
					}
					if (classifyTool(ev.name) !== 'read') { result.output += `\n${ev.arguments}`; }
					result.reportedToolCalls++;
					progress.report(new vscode.LanguageModelToolCallPart(ev.id, ev.name, parseArgs(ev.arguments, this.log)));
					break;
				case 'usage':
					if (settings.logUsage) {
						const cost = ev.usage.cost != null ? ` $${ev.usage.cost.toFixed(5)}` : '';
						const cached = ev.usage.prompt_tokens_details?.cached_tokens ? `, ${ev.usage.prompt_tokens_details.cached_tokens} cached` : '';
						this.log.info(`${opts.label}${model}: ${ev.usage.prompt_tokens} in${cached} / ${ev.usage.completion_tokens} out${cost} (${Date.now() - t0} ms)`);
					}
					break;
			}
		}
		return result;
	}

	async provideTokenCount(
		_model: ModelInfo,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokens(text);
	}

	async getCatalog(force = false): Promise<ORModel[]> {
		if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL) {
			return this.modelCache.models;
		}
		const models = await this.client.listModels();
		this.modelCache = { at: Date.now(), models };
		this.registry.update(models);
		this.log.info(`Loaded ${models.length} OpenRouter models`);
		return models;
	}

	private targetModel(target: string, ensembles: EnsembleConfig[]): string | undefined {
		return target.startsWith(ENSEMBLE_PREFIX)
			? ensembles.find(e => e.id === target.slice(ENSEMBLE_PREFIX.length))?.aggregator
			: target;
	}
}

// -------------------------------------------------------------------------------------------------

interface RunOptions {
	options: vscode.ProvideLanguageModelChatResponseOptions;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
	signal: AbortSignal;
	settings: GeneralSettings;
	sessionId?: string;
	maxOutputTokens: number;
	source: Source;
	runId?: string;
}

const STRATEGY_LABEL = { moa: 'Mixture of agents', council: 'Council', judge: 'Judge', plan: 'Plan & build' } as const;

/** Stable per conversation: derived from the first user message, used for OpenRouter sticky routing. */
function conversationId(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | undefined {
	const first = messages.find(m => m.role === vscode.LanguageModelChatMessageRole.User);
	const text = first?.content.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart).map(p => p.value).join('');
	return text ? `vscode-${createHash('sha1').update(text).digest('hex').slice(0, 24)}` : undefined;
}

function hasImages(messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
	return messages.some(m => m.content.some(p => p instanceof vscode.LanguageModelDataPart && p.mimeType.startsWith('image/')));
}

/** Injects the ensemble context into the system prompt (merging, since some models accept only one). */
function injectSystem(messages: ReturnType<typeof toOpenRouterMessages>, block: string) {
	const out = [...messages];
	const first = out[0];
	if (first?.role === 'system' && typeof first.content === 'string') {
		out[0] = { ...first, content: `${first.content}\n\n${block}` };
	} else {
		out.unshift({ role: 'system', content: block });
	}
	return out;
}
function modelLimits(m: ORModel) {
	const context = m.top_provider?.context_length ?? m.context_length ?? 128_000;
	const maxOutputTokens = Math.min(m.top_provider?.max_completion_tokens ?? 16_384, OUTPUT_CAP, Math.floor(context / 4));
	return { maxInputTokens: Math.max(context - maxOutputTokens, 4096), maxOutputTokens };
}

/** `:batch` variants belong to OpenRouter's batch API and don't work for live chat. */
export function isChatModel(m: ORModel) {
	return !m.id.endsWith(':batch');
}

function supportsTools(m: ORModel) {
	return !!m.supported_parameters?.includes('tools');
}

function supportsImages(m: ORModel) {
	return !!m.architecture?.input_modalities?.includes('image');
}

function shortName(id: string) {
	return id.replace(/^ensemble:/, '').replace(/^~/, '').split('/').pop() ?? id;
}

function parseArgs(raw: string, log: vscode.LogOutputChannel): object {
	if (!raw.trim()) { return {}; }
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed };
	} catch {
		log.warn(`Tool call arguments are not valid JSON: ${raw.slice(0, 300)}`);
		return {};
	}
}

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}
