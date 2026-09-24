import * as vscode from 'vscode';
import type { ORAssistantMessage, ORContentPart, ORMessage, ORTool, ORToolCall } from './openrouter';

// The System role (3) is only in proposed API, but Copilot Chat sends it. Handle it defensively.
const SYSTEM_ROLE = 3;

function isImage(part: vscode.LanguageModelDataPart): boolean {
	return part.mimeType.startsWith('image/');
}

function isTextual(part: vscode.LanguageModelDataPart): boolean {
	return part.mimeType.startsWith('text/') || part.mimeType.includes('json');
}

function decode(part: vscode.LanguageModelDataPart): string {
	return new TextDecoder().decode(part.data);
}

function toDataUrl(part: vscode.LanguageModelDataPart): string {
	return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

/** Flattens the content of a tool result into plain text. */
export function toolResultToText(part: vscode.LanguageModelToolResultPart): string {
	const out: string[] = [];
	for (const c of part.content) {
		if (c instanceof vscode.LanguageModelTextPart) {
			out.push(c.value);
		} else if (c instanceof vscode.LanguageModelDataPart && isTextual(c)) {
			out.push(decode(c));
		}
		// Prompt-TSX parts and unknown parts are skipped
	}
	return out.join('\n');
}

/** Converts VS Code chat messages into OpenAI/OpenRouter chat-completions messages. */
export function toOpenRouterMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	opts: { images: boolean },
): ORMessage[] {
	const result: ORMessage[] = [];

	for (const msg of messages) {
		const role = msg.role as number;

		if (role === vscode.LanguageModelChatMessageRole.Assistant) {
			let text = '';
			const toolCalls: ORToolCall[] = [];
			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					text += part.value;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({
						id: part.callId,
						type: 'function',
						function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
					});
				}
			}
			if (text || toolCalls.length) {
				const assistant: ORAssistantMessage = { role: 'assistant', content: text || null };
				if (toolCalls.length) { assistant.tool_calls = toolCalls; }
				result.push(assistant);
			}
			continue;
		}

		// User or system: tool results must directly follow the assistant tool_calls message,
		// so emit them first as separate `tool` messages.
		const content: ORContentPart[] = [];
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelToolResultPart) {
				result.push({ role: 'tool', tool_call_id: part.callId, content: toolResultToText(part) || '(empty result)' });
			} else if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value) { content.push({ type: 'text', text: part.value }); }
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (isImage(part) && opts.images) {
					content.push({ type: 'image_url', image_url: { url: toDataUrl(part) } });
				} else if (isTextual(part)) {
					content.push({ type: 'text', text: decode(part) });
				}
				// other mime types (e.g. cache-control markers from Copilot) are ignored
			}
		}
		if (!content.length) { continue; }

		const texts = content.flatMap(c => c.type === 'text' ? [c.text] : []);
		if (role === SYSTEM_ROLE) {
			// System messages are text-only
			result.push({ role: 'system', content: texts.join('\n') });
		} else {
			const onlyText = texts.length === content.length;
			result.push({ role: 'user', content: onlyText ? texts.join('\n') : content });
		}
	}
	return result;
}

export function toOpenRouterTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): ORTool[] | undefined {
	if (!tools?.length) { return undefined; }
	return tools.map(t => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
		},
	}));
}

/**
 * Renders the whole conversation as a single text transcript for proposers.
 * Proposers cannot call tools, so tool calls/results are inlined as text.
 */
export function flattenToTranscript(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	maxChars: number,
	maxToolResultChars = 8000,
): string {
	const lines: string[] = [];
	for (const msg of messages) {
		const role = msg.role as number;
		const label = role === vscode.LanguageModelChatMessageRole.Assistant ? 'ASSISTANT'
			: role === SYSTEM_ROLE ? 'SYSTEM' : 'USER';
		const chunks: string[] = [];
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				chunks.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				chunks.push(`[tool call] ${part.name}(${JSON.stringify(part.input)})`);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let text = toolResultToText(part);
				if (text.length > maxToolResultChars) {
					text = text.slice(0, maxToolResultChars) + '\n…[truncated]';
				}
				chunks.push(`[tool result]\n${text}`);
			} else if (part instanceof vscode.LanguageModelDataPart && isTextual(part)) {
				chunks.push(decode(part));
			} else if (part instanceof vscode.LanguageModelDataPart && isImage(part)) {
				chunks.push('[image omitted]');
			}
		}
		const body = chunks.join('\n').trim();
		if (body) { lines.push(`### ${label}\n${body}`); }
	}
	const transcript = lines.join('\n\n');
	return transcript.length > maxChars
		? '…[earlier conversation truncated]\n' + transcript.slice(transcript.length - maxChars)
		: transcript;
}

/** Text of the latest genuine user message (not a tool-result continuation). */
export function lastUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== vscode.LanguageModelChatMessageRole.User) { continue; }
		if (msg.content.some(p => p instanceof vscode.LanguageModelToolResultPart)) { continue; }
		const text = msg.content
			.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
			.map(p => p.value).join('\n');
		if (text) { return text; }
	}
	return '';
}

export function isToolContinuation(messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
	const last = messages[messages.length - 1];
	return !!last?.content.some(p => p instanceof vscode.LanguageModelToolResultPart);
}

export function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof text === 'string') { return Math.ceil(text.length / 4); }
	let chars = 0;
	for (const part of text.content) {
		if (part instanceof vscode.LanguageModelTextPart) { chars += part.value.length; }
		else if (part instanceof vscode.LanguageModelToolResultPart) { chars += toolResultToText(part).length; }
		else if (part instanceof vscode.LanguageModelToolCallPart) { chars += JSON.stringify(part.input).length + part.name.length; }
		else if (part instanceof vscode.LanguageModelDataPart) { chars += isImage(part) ? 3000 : part.data.byteLength; }
	}
	return Math.ceil(chars / 4);
}
