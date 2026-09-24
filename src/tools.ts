import * as vscode from 'vscode';

/** Internal handoff tool: the final model calls it when it has gathered enough context. Never reported to VS Code. */
export const DRAFTS_TOOL_NAME = 'request_expert_drafts';

export const DRAFTS_TOOL: vscode.LanguageModelChatTool = {
	name: DRAFTS_TOOL_NAME,
	description: 'Call this once you have gathered enough context (memory, relevant files, search results) to plan the change. '
		+ 'Several expert models will then draft solutions based on everything in this conversation, and you get the full toolset '
		+ 'to implement the result. Takes no arguments.',
	inputSchema: { type: 'object', properties: {} },
};

// Words in tool names. Write verbs win over read verbs ("get_terminal_output" runs in a terminal context → excluded).
const WRITE = new Set(['create', 'write', 'edit', 'edits', 'replace', 'insert', 'apply', 'patch', 'delete', 'remove', 'rename', 'move',
	'run', 'runs', 'exec', 'execute', 'terminal', 'install', 'commit', 'push', 'update', 'set', 'save', 'deploy', 'send', 'post', 'put',
	'kill', 'new', 'merge', 'close', 'open', 'start', 'stop', 'restart', 'upload', 'publish', 'subagent']);
const READ = new Set(['read', 'get', 'list', 'search', 'find', 'grep', 'fetch', 'view', 'show', 'lookup', 'query', 'usages', 'usage',
	'symbols', 'symbol', 'errors', 'problems', 'diff', 'changes', 'changed', 'status', 'memory', 'memories', 'todo', 'think', 'describe',
	'inspect', 'explain', 'semantic', 'references', 'definition', 'hover', 'outline', 'tree', 'log', 'blame', 'history', 'dir', 'files']);

/** Splits snake_case, kebab-case, dotted and camelCase names into lowercase words. */
export function toolWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.map(w => w.toLowerCase())
		.filter(Boolean);
}

/**
 * Read-only tools are safe during exploration. Unknown tools are treated as not read-only:
 * better to hide a harmless tool for a moment than to let the model edit before the drafts arrive.
 */
export function classifyTool(name: string): 'read' | 'write' | 'unknown' {
	const words = toolWords(name);
	if (words.some(w => WRITE.has(w))) { return 'write'; }
	if (words.some(w => READ.has(w))) { return 'read'; }
	return 'unknown';
}

/** Tool rounds the model has already done for the latest user message. */
export function explorationRounds(messages: readonly vscode.LanguageModelChatRequestMessage[]): number {
	let rounds = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === vscode.LanguageModelChatMessageRole.User && !m.content.some(p => p instanceof vscode.LanguageModelToolResultPart)) {
			break; // reached the user's message
		}
		if (m.role === vscode.LanguageModelChatMessageRole.Assistant && m.content.some(p => p instanceof vscode.LanguageModelToolCallPart)) {
			rounds++;
		}
	}
	return rounds;
}
