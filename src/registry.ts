import { EFFORTS, type Effort, type GeneralSettings } from './config';
import type { ORChatParams, ORModel } from './openrouter';

/** Options a stage asks for; the registry drops what the model does not support. */
export interface CallOptions {
	temperature?: number;
	reasoning?: Effort;
	maxTokens?: number;
	sessionId?: string;
}

/**
 * Knows what each OpenRouter model supports (from the live catalog) and turns stage options into
 * request parameters. Unsupported parameters are left out instead of risking a 400 from a provider.
 */
export class ModelRegistry {
	private byId = new Map<string, ORModel>();

	update(models: ORModel[]) {
		this.byId = new Map(models.map(m => [m.id, m]));
	}

	get(id: string): ORModel | undefined {
		return this.byId.get(id);
	}

	ids(): string[] {
		return [...this.byId.keys()];
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	/** Unknown models are assumed to support everything (the catalog may be stale). */
	supports(id: string, param: string): boolean {
		const m = this.byId.get(id);
		return !m || !!m.supported_parameters?.includes(param as never);
	}

	supportsTools(id: string): boolean {
		return this.supports(id, 'tools');
	}

	supportsImages(id: string): boolean {
		const m = this.byId.get(id);
		return !m || !!m.architecture?.input_modalities?.includes('image' as never);
	}

	/**
	 * Maps a wanted effort to one the model actually supports (nearest level). Models with mandatory
	 * reasoning never get "none"; they get their lowest supported level instead.
	 */
	resolveEffort(model: string, wanted: Effort): Effort | undefined {
		const r = this.byId.get(model)?.reasoning;
		if (!r) { return wanted; }
		let supported = (r.supported_efforts ?? []).filter((e): e is Effort => (EFFORTS as readonly string[]).includes(e as string));
		if (r.mandatory) { supported = supported.filter(e => e !== 'none'); }
		if (!supported.length) {
			// No explicit list: pass through, except "none" on mandatory models
			return r.mandatory && wanted === 'none' ? undefined : wanted;
		}
		if (supported.includes(wanted)) { return wanted; }
		const rank = (e: Effort) => EFFORTS.indexOf(e);
		return supported.reduce((best, e) => Math.abs(rank(e) - rank(wanted)) < Math.abs(rank(best) - rank(wanted)) ? e : best);
	}

	/** Parameters for one request; `settings` provides fallbacks, per-model reasoning and sticky sessions. */
	params(model: string, opts: CallOptions, settings: GeneralSettings): Omit<ORChatParams, 'messages'> {
		const out: Omit<ORChatParams, 'messages'> = { model };

		if (opts.maxTokens) { out.max_tokens = opts.maxTokens; }
		if (opts.temperature !== undefined && this.supports(model, 'temperature')) {
			out.temperature = opts.temperature;
		}

		const wanted = opts.reasoning ?? settings.modelReasoning[model];
		const effort = wanted && this.resolveEffort(model, wanted);
		if (effort && (this.supports(model, 'reasoning') || this.supports(model, 'reasoning_effort'))) {
			out.reasoning = { effort };
		}

		// OpenRouter tries these in order when the primary model is down or rate-limited
		const fallbacks = settings.fallbacks[model]?.filter(f => f !== model);
		if (fallbacks?.length) {
			out.models = [model, ...fallbacks];
		}

		// Sticky routing: same provider for the whole conversation, which maximizes prompt-cache hits
		if (settings.stickySessions && opts.sessionId) {
			out.session_id = opts.sessionId;
		}
		return out;
	}
}
