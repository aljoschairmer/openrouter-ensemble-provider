import type * as vscode from 'vscode';
import type { CallMeta, UsageEvent } from './usage';

const BASE_URL = 'https://openrouter.ai/api/v1';

// Wire-format types generated from OpenRouter's OpenAPI spec (npm run gen:types).
// Type-only import: nothing from the generated file ends up in the bundle.
import type { components, operations } from './generated/openrouter-api';

type Schemas = components['schemas'];

export type ORMessage = Schemas['ChatMessages'];
export type ORContentPart = Schemas['ChatContentItems'];
export type ORToolCall = Schemas['ChatToolCall'];
/** Client-side function tools only (the union also contains OpenRouter server tools). */
export type ORTool = Extract<Schemas['ChatFunctionTool'], { type: 'function'; function: { name: string } }>;
export type ORRequest = Schemas['ChatRequest'];
/** Request parameters; `stream` is set by `complete()` / `stream()`. */
export type ORChatParams = Omit<ORRequest, 'stream'>;
export type ORSystemMessage = Schemas['ChatSystemMessage'];
export type ORUserMessage = Schemas['ChatUserMessage'];
export type ORAssistantMessage = Schemas['ChatAssistantMessage'];
export type ORModel = Schemas['Model'];
export type ORUsage = Schemas['ChatUsage'];
export type ORKeyInfo = operations['getCurrentKey']['responses'][200]['content']['application/json']['data'];
type ORStreamChunk = Schemas['ChatStreamChunk'];
type ORResult = Schemas['ChatResult'];
type ORErrorBody = { error?: { message?: string; code?: number } };
export type ORActivityItem = Schemas['ActivityItem'];
export type ORCredits = operations['getCredits']['responses'][200]['content']['application/json']['data'];

export type StreamEvent =
	| { type: 'text'; text: string }
	| { type: 'toolCall'; id: string; name: string; arguments: string }
	| { type: 'usage'; usage: ORUsage };

export class OpenRouterError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
	}
}

export class OpenRouterClient {
	/** Receives the usage of every call that carries metadata (set by the extension). */
	onUsage?: (event: UsageEvent) => void;

	constructor(
		private readonly getApiKey: () => Promise<string | undefined>,
		private readonly getExtraBody: () => Record<string, unknown>,
		private readonly log: vscode.LogOutputChannel,
	) { }

	private async headers(opts: { optional?: boolean; key?: string } = {}): Promise<Record<string, string>> {
		const key = opts.key ?? await this.getApiKey();
		if (!key && !opts.optional) {
			throw new OpenRouterError('No OpenRouter API key configured. Run "OpenRouter Ensemble: Open Settings".', 401);
		}
		return {
			...(key ? { 'Authorization': `Bearer ${key}` } : {}),
			'Content-Type': 'application/json',
			// OpenRouter app attribution headers
			'HTTP-Referer': 'https://github.com/aljoschairmer/openrouter-ensemble',
			'X-Title': 'OpenRouter Ensemble (VS Code)',
		};
	}

	/** The model catalog is public, so this also works before a key is configured. */
	async listModels(signal?: AbortSignal): Promise<ORModel[]> {
		const res = await fetch(`${BASE_URL}/models`, { headers: await this.headers({ optional: true }), signal });
		await this.ensureOk(res);
		const json = await res.json() as { data: ORModel[] };
		return json.data ?? [];
	}

	/** Validates a key (the stored one, or a candidate) and returns its label, usage and limit. */
	async getKeyInfo(key?: string, signal?: AbortSignal): Promise<ORKeyInfo> {
		const res = await fetch(`${BASE_URL}/key`, { headers: await this.headers({ key }), signal });
		await this.ensureOk(res);
		const json = await res.json() as { data: ORKeyInfo };
		return json.data;
	}

	/** Account-wide daily usage per model for the last 30 completed UTC days. Needs a management key. */
	async getActivity(managementKey: string, signal?: AbortSignal): Promise<ORActivityItem[]> {
		const res = await fetch(`${BASE_URL}/activity`, { headers: await this.headers({ key: managementKey }), signal });
		await this.ensureOk(res);
		return ((await res.json()) as { data?: ORActivityItem[] }).data ?? [];
	}

	/** Account credit balance. Needs a management key. */
	async getCredits(managementKey: string, signal?: AbortSignal): Promise<ORCredits> {
		const res = await fetch(`${BASE_URL}/credits`, { headers: await this.headers({ key: managementKey }), signal });
		await this.ensureOk(res);
		return ((await res.json()) as { data: ORCredits }).data;
	}

	private emitUsage(model: string, usage: ORUsage | undefined, meta: CallMeta | undefined, started: number) {
		if (!meta || !usage || !this.onUsage) { return; }
		try {
			this.onUsage({
				at: Date.now(),
				model,
				stage: meta.stage,
				source: meta.source,
				runId: meta.runId,
				promptTokens: usage.prompt_tokens ?? 0,
				completionTokens: usage.completion_tokens ?? 0,
				cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
				reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
				cost: usage.cost ?? 0,
				ms: Date.now() - started,
			});
		} catch (err) {
			this.log.warn(`Recording usage failed: ${err}`);
		}
	}

	/** Non-streaming completion, used for proposers and council rankings. */
	async complete(req: ORChatParams, signal?: AbortSignal, meta?: CallMeta): Promise<{ text: string; usage?: ORUsage }> {
		const started = Date.now();
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: await this.headers(),
			// Usage (incl. cost) is always included by OpenRouter; no opt-in parameter needed.
			body: JSON.stringify({ ...this.getExtraBody(), ...req, stream: false } satisfies ORRequest),
			signal,
		});
		await this.ensureOk(res);
		const json = await res.json() as ORResult & ORErrorBody;
		if (json.error) {
			throw new OpenRouterError(json.error.message ?? 'Unknown OpenRouter error', json.error.code);
		}
		const content = json.choices?.[0]?.message?.content;
		const text = typeof content === 'string' ? content
			: Array.isArray(content) ? content.map(p => p.type === 'text' ? p.text : '').join('') : '';
		this.emitUsage(req.model ?? '', json.usage, meta, started);
		return { text, usage: json.usage };
	}

	/** Streaming completion (SSE). Text is yielded as it arrives, tool calls once complete. */
	async *stream(req: ORChatParams, signal?: AbortSignal, meta?: CallMeta): AsyncGenerator<StreamEvent> {
		const started = Date.now();
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: await this.headers(),
			body: JSON.stringify({ ...this.getExtraBody(), ...req, stream: true } satisfies ORRequest),
			signal,
		});
		await this.ensureOk(res);
		if (!res.body) {
			throw new OpenRouterError('Empty response body from OpenRouter');
		}

		const pending = new Map<number, { id: string; name: string; args: string }>();
		const flushToolCalls = function* (): Generator<StreamEvent> {
			for (const [, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
				if (call.name) {
					yield { type: 'toolCall', id: call.id, name: call.name, arguments: call.args };
				}
			}
			pending.clear();
		};

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				buffer += decoder.decode(value, { stream: true });

				let newline: number;
				while ((newline = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);

					// SSE comments like ": OPENROUTER PROCESSING" keep the connection alive
					if (!line.startsWith('data:')) { continue; }
					const data = line.slice(5).trim();
					if (data === '[DONE]') {
						yield* flushToolCalls();
						return;
					}

					let chunk: ORStreamChunk;
					try {
						chunk = JSON.parse(data) as ORStreamChunk;
					} catch {
						this.log.warn(`Unparseable SSE chunk: ${data.slice(0, 200)}`);
						continue;
					}
					if (chunk.error) {
						throw new OpenRouterError(chunk.error.message ?? 'Stream error', chunk.error.code);
					}
					if (chunk.usage) {
						this.emitUsage(req.model ?? '', chunk.usage, meta, started);
						yield { type: 'usage', usage: chunk.usage };
					}

					const choice = chunk.choices?.[0];
					const delta = choice?.delta;
					if (delta?.content) {
						yield { type: 'text', text: delta.content };
					}
					for (const tc of delta?.tool_calls ?? []) {
						const idx: number = tc.index ?? 0;
						const entry = pending.get(idx) ?? { id: '', name: '', args: '' };
						if (tc.id) { entry.id = tc.id; }
						if (tc.function?.name) { entry.name += tc.function.name; }
						if (tc.function?.arguments) { entry.args += tc.function.arguments; }
						if (!entry.id) { entry.id = `call_${Date.now()}_${idx}`; }
						pending.set(idx, entry);
					}
					if (choice?.finish_reason) {
						yield* flushToolCalls();
					}
				}
			}
			yield* flushToolCalls();
		} finally {
			reader.releaseLock();
		}
	}

	private async ensureOk(res: Response): Promise<void> {
		if (res.ok) { return; }
		let message = `${res.status} ${res.statusText}`;
		try {
			const body = await res.json() as { error?: { message?: string } };
			if (body.error?.message) { message = `${res.status}: ${body.error.message}`; }
		} catch { /* ignore */ }
		throw new OpenRouterError(`OpenRouter request failed (${message})`, res.status);
	}
}
