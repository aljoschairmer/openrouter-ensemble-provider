import { execFile, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { cfg } from './config';
import type { ManagedGraphify } from './graphInstall';

/**
 * Code knowledge graph via graphify (https://github.com/Graphify-Labs/graphify).
 *
 * graphify is an external Python CLI. It is never bundled: the extension uses an existing install from the
 * PATH, or installs its own copy on request (see graphInstall.ts: uv + graphify in the extension's storage,
 * no Python needed on the machine). It builds
 * the graph on request (`extract --code-only`: local tree-sitter parsing, no LLM, nothing leaves the
 * machine) and exposes graphify's own MCP server (`graphify-mcp`) to VS Code. The graph
 * tools then show up in `options.tools` like any other tool, for single models, ensembles and routers.
 */

export const MCP_PROVIDER_ID = 'openrouterEnsemble.graphify';
export const GRAPH_DIR = 'graphify-out';
export const GRAPH_FILE = 'graph.json';
export const INSTALL_HINT = 'uv tool install "graphifyy[mcp]"';

export type GraphState =
	| 'disabled'     // setting off
	| 'untrusted'    // restricted mode: never run executables from here
	| 'missing-cli'  // graphify not found
	| 'missing-mcp'  // graphify found, but installed without the [mcp] extra
	| 'ready';

export interface GraphStatus {
	state: GraphState;
	cli?: string;
	/** The CLI is the extension's own managed install. */
	managed?: boolean;
	/** No usable graphify, but the extension can install one itself. */
	canInstall?: boolean;
	/** How the MCP server is started: graphify's own `graphify-mcp` launcher, or `<python> -m graphify.serve`. */
	server?: { command: string; args: string[] };
	python?: string;
	detail?: string;
	/** Workspace folders with a built graph (only meaningful when ready). */
	graphs: { folder: vscode.WorkspaceFolder; file: string }[];
	/** Local workspace folders without a graph yet. */
	missing: vscode.WorkspaceFolder[];
}

interface GraphSettings {
	enabled: boolean;
	command: string;
	python: string;
}

export function readGraphSettings(): GraphSettings {
	const c = cfg();
	return {
		enabled: c.get<boolean>('graph.enabled') ?? false,
		command: (c.get<string>('graph.command') ?? '').trim() || 'graphify',
		python: (c.get<string>('graph.python') ?? '').trim(),
	};
}

// -------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// -------------------------------------------------------------------------------------------------

/**
 * Finds the Python interpreter behind a console-script launcher, so the MCP server runs in the same
 * environment as the CLI (uv tool / pipx install into isolated venvs, where plain `python` has no graphify).
 * - POSIX scripts: `#!/path/to/python`, or for paths with spaces `#!/bin/sh` + `'''exec' "/path/python" "$0" "$@"` (pip) / `'…'` (uv).
 * - Windows .exe launchers (pip/distlib, uv trampoline) embed the interpreter path near the end of the file.
 */
export function interpreterFromLauncher(content: Buffer): string | undefined {
	const head = content.subarray(0, 2048).toString('utf8');
	if (head.startsWith('#!')) {
		const first = head.split(/\r?\n/, 1)[0].slice(2).trim();
		// pip quotes with "…", uv with '…'
		const execForm = /^'''exec' (["'])(.+?python[^"'\s]*)\1 /m.exec(head);
		if (execForm) { return execForm[2]; }
		if (/python[\d.]*$/.test(first) && !first.includes(' ')) { return first; }
		const env = /^\/usr\/bin\/env\s+(python[\d.]*)$/.exec(first);
		if (env) { return env[1]; }
		return undefined;
	}
	const tail = content.subarray(Math.max(0, content.length - 64 * 1024)).toString('latin1');
	const matches = tail.match(/[A-Za-z]:\\[^\0\r\n"<>|*?]*?pythonw?\.exe/gi);
	return matches?.[matches.length - 1];
}

/** Resolves a bare command name against PATH (and PATHEXT on Windows). Absolute paths are checked as-is. */
export async function findExecutable(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (p: string) => Promise<boolean> = isFile,
): Promise<string | undefined> {
	const p = platform === 'win32' ? path.win32 : path.posix;
	// Windows: a name without extension only runs via PATHEXT (an extensionless file there is a POSIX script, not runnable)
	const exts = platform === 'win32' && !p.extname(command)
		? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())
		: [''];
	const candidates = p.isAbsolute(command) || command.includes(p.sep)
		? exts.map(e => command + e)
		: (env.PATH ?? env.Path ?? '').split(p.delimiter).filter(Boolean).flatMap(dir => exts.map(e => p.join(dir, command + e)));
	for (const c of candidates) {
		if (await exists(c)) { return c; }
	}
	return undefined;
}

/** "wrote …/graph.json: 542 nodes, 1056 edges, 31 communities" → counts. */
export function parseBuildSummary(output: string): { nodes: number; edges: number } | undefined {
	const m = /(\d+)\s+nodes?,\s*(\d+)\s+edges?/.exec(output);
	return m ? { nodes: Number(m[1]), edges: Number(m[2]) } : undefined;
}

/** `…/bin/graphify` → `…/bin/graphify-mcp`, `…\\Scripts\\graphify.exe` → `…\\Scripts\\graphify-mcp.exe`. */
export async function siblingExecutable(file: string, name: string, exists: (p: string) => Promise<boolean> = isFile): Promise<string | undefined> {
	const ext = path.extname(file);
	const candidate = path.join(path.dirname(file), name + (/^\.(exe|cmd|bat)$/i.test(ext) ? ext : ''));
	return await exists(candidate) ? candidate : undefined;
}

async function isFile(p: string): Promise<boolean> {
	try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

// -------------------------------------------------------------------------------------------------

export class GraphService implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeMcpServerDefinitions = this.changeEmitter.event;
	private readonly statusEmitter = new vscode.EventEmitter<GraphStatus>();
	readonly onDidChangeStatus = this.statusEmitter.event;

	private statusCache?: Promise<GraphStatus>;
	private lastSignature = '';
	private readonly disposables: vscode.Disposable[] = [];
	private readonly running = new Set<ChildProcess>();
	private building = false;
	private installing?: Promise<boolean>;

	constructor(private readonly log: vscode.LogOutputChannel, readonly managed?: ManagedGraphify) {
		const watcher = vscode.workspace.createFileSystemWatcher(`**/${GRAPH_DIR}/${GRAPH_FILE}`);
		// The MCP server hot-reloads graph.json itself; only a graph appearing or disappearing changes the server list.
		this.disposables.push(
			watcher,
			watcher.onDidCreate(() => this.refresh()),
			watcher.onDidDelete(() => this.refresh()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
		);
	}

	dispose() {
		this.running.forEach(p => p.kill());
		this.disposables.forEach(d => d.dispose());
		this.changeEmitter.dispose();
		this.statusEmitter.dispose();
	}

	/** Re-detects the CLI and graphs; tells VS Code when the set of servers changed. */
	refresh() {
		this.statusCache = undefined;
		void this.status().then(s => {
			const signature = JSON.stringify([s.state, s.server, s.graphs.map(g => g.file)]);
			if (signature !== this.lastSignature) {
				this.lastSignature = signature;
				this.log.info(`Knowledge graph: ${describe(s)}`);
				this.changeEmitter.fire();
			}
			this.statusEmitter.fire(s);
		});
	}

	status(): Promise<GraphStatus> {
		return this.statusCache ??= this.detect();
	}

	// ---- McpServerDefinitionProvider ------------------------------------------------------------

	async provideMcpServerDefinitions(): Promise<vscode.McpStdioServerDefinition[]> {
		const s = await this.status();
		if (s.state !== 'ready' || !s.server) { return []; }
		const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
		return s.graphs.map(({ folder, file }) => {
			const def = new vscode.McpStdioServerDefinition(
				multi ? `graphify ${folder.name}` : 'graphify',
				s.server!.command,
				[...s.server!.args, file],
				{ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
				'1',
			);
			def.cwd = folder.uri;
			return def;
		});
	}

	async resolveMcpServerDefinition(server: vscode.McpStdioServerDefinition): Promise<vscode.McpStdioServerDefinition | undefined> {
		// Re-check right before VS Code starts the server: the graph may have been deleted in the meantime.
		const file = server.args[server.args.length - 1];
		return await isFile(file) ? server : undefined;
	}

	// ---- Build ----------------------------------------------------------------------------------

	/** Builds (or incrementally updates) the graph for one folder. Code only: no LLM, no network. */
	async build(folder?: vscode.WorkspaceFolder): Promise<boolean> {
		const s = await this.status();
		if (s.state === 'disabled') {
			const choice = await vscode.window.showInformationMessage('The code knowledge graph is turned off.', 'Turn On');
			if (choice !== 'Turn On') { return false; }
			await cfg().update('graph.enabled', true, vscode.ConfigurationTarget.Global);
			this.statusCache = undefined;
			return this.build(folder);
		}
		if (s.state === 'untrusted') {
			void vscode.window.showWarningMessage('Building the knowledge graph runs graphify on this folder. Trust the workspace first.');
			return false;
		}
		if (s.state === 'missing-cli' || s.state === 'missing-mcp') {
			if (!await this.offerInstall(s)) { return false; }
			return this.build(folder);
		}
		const target = folder ?? await this.pickFolder([...s.graphs.map(g => g.folder), ...s.missing]);
		if (!target) { return false; }

		const exists = s.graphs.some(g => g.folder.uri.toString() === target.uri.toString());
		const args = exists ? ['update', target.uri.fsPath] : ['extract', target.uri.fsPath, '--code-only'];
		this.building = true;
		const ok = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `${exists ? 'Updating' : 'Building'} knowledge graph for ${target.name}`,
			cancellable: true,
		}, async (_progress, token) => {
			try {
				const out = await this.exec(s.cli!, args, target.uri.fsPath, token, 10 * 60_000);
				const summary = parseBuildSummary(out);
				this.log.info(`graphify ${args[0]} ${target.name}: ${summary ? `${summary.nodes} nodes, ${summary.edges} edges` : 'done'}`);
				void vscode.window.showInformationMessage(
					`Knowledge graph ${exists ? 'updated' : 'built'} for ${target.name}${summary ? `: ${summary.nodes} nodes, ${summary.edges} edges` : ''}.`
					+ (exists ? '' : ` Add ${GRAPH_DIR}/ to .gitignore if you don't want to commit it.`));
				return true;
			} catch (err) {
				if (token.isCancellationRequested) { return false; }
				this.log.error(`graphify ${args[0]} failed: ${errorMessage(err)}`);
				void vscode.window.showErrorMessage(`Building the knowledge graph failed: ${lastLine(errorMessage(err))}`, 'Show Log')
					.then(c => c && this.log.show());
				return false;
			}
		}).then(r => r, () => false);
		this.building = false;
		this.refresh();
		return ok;
	}

	/** One-time hint per workspace when the feature is on but no folder has a graph yet. */
	async maybeSuggestBuild(state: vscode.Memento): Promise<void> {
		const s = await this.status();
		if (s.state === 'missing-cli' || s.state === 'missing-mcp') {
			if (!state.get('graph.installHintShown')) {
				await state.update('graph.installHintShown', true);
				if (await this.offerInstall(s)) { return this.maybeSuggestBuild(state); }
			}
			return;
		}
		if (this.building || s.state !== 'ready' || s.graphs.length || !s.missing.length || state.get('graph.buildHintShown')) { return; }
		await state.update('graph.buildHintShown', true);
		const choice = await vscode.window.showInformationMessage(
			'No code knowledge graph for this workspace yet. Build one? (Local, code only, no API calls.)', 'Build Graph');
		if (choice) { await this.build(s.missing.length === 1 ? s.missing[0] : undefined); }
	}

	// ---- Detection ------------------------------------------------------------------------------

	private async detect(): Promise<GraphStatus> {
		const settings = readGraphSettings();
		const empty = { graphs: [], missing: [] };
		if (!settings.enabled) { return { state: 'disabled', ...empty }; }
		if (!vscode.workspace.isTrusted) { return { state: 'untrusted', ...empty }; }

		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
		const graphs: GraphStatus['graphs'] = [];
		const missing: vscode.WorkspaceFolder[] = [];
		for (const folder of folders) {
			const file = path.join(folder.uri.fsPath, GRAPH_DIR, GRAPH_FILE);
			if (await isFile(file)) { graphs.push({ folder, file }); } else { missing.push(folder); }
		}

		// An explicitly configured command wins. Otherwise: graphify on the PATH, then the extension's own install.
		const explicit = settings.command !== 'graphify';
		const candidates: { cli: string; managed: boolean }[] = [];
		const onPath = await findExecutable(settings.command);
		if (onPath) { candidates.push({ cli: onPath, managed: false }); }
		if (!explicit && this.managed && await this.managed.installed()) { candidates.push({ cli: this.managed.cliPath, managed: true }); }
		const canInstall = !explicit && !!this.managed?.supported;

		let first: GraphStatus | undefined;
		for (const c of candidates) {
			const s = await this.evaluate(c.cli, settings.python, graphs, missing);
			if (s.state === 'ready') { return { ...s, managed: c.managed }; }
			first ??= { ...s, managed: c.managed, canInstall: canInstall && !c.managed };
		}
		return first ?? {
			state: 'missing-cli', canInstall, graphs, missing,
			detail: `"${settings.command}" is not on the PATH`,
		};
	}

	/** Checks one graphify CLI: batch wrapper, MCP launcher / interpreter, [mcp] extra importable. */
	private async evaluate(cli: string, pythonSetting: string, graphs: GraphStatus['graphs'], missing: vscode.WorkspaceFolder[]): Promise<GraphStatus> {
		if (/\.(cmd|bat)$/i.test(cli)) {
			// Batch wrappers only run through a shell, and neither we nor VS Code's MCP host use one
			return { state: 'missing-cli', cli, detail: `${cli} is a batch wrapper; point openrouterEnsemble.graph.command at graphify.exe`, graphs, missing };
		}

		// Prefer graphify's own MCP launcher next to the CLI (same venv, works on every platform)
		const mcpLauncher = pythonSetting ? undefined : await siblingExecutable(cli, 'graphify-mcp');
		let python = pythonSetting || undefined;
		if (!python) {
			try { python = interpreterFromLauncher(await fs.readFile(mcpLauncher ?? cli)); } catch { /* unreadable launcher */ }
		}
		if (python && !path.isAbsolute(python)) { python = await findExecutable(python) ?? python; }
		if (!python && !mcpLauncher) { python = await findExecutable(process.platform === 'win32' ? 'python' : 'python3'); }
		const server = mcpLauncher ? { command: mcpLauncher, args: [] }
			: python ? { command: python, args: ['-m', 'graphify.serve'] }
			: undefined;

		if (!server) { return { state: 'missing-mcp', cli, detail: 'no Python interpreter found for graphify', graphs, missing }; }
		// The MCP SDK is an optional extra of graphifyy; check it's importable so VS Code doesn't get a server that dies on start
		if (python) {
			try {
				await this.exec(python, ['-c', 'import graphify.serve, mcp'], undefined, undefined, 30_000);
			} catch (err) {
				const msg = errorMessage(err);
				const state: GraphState = /No module named '?mcp/.test(msg) ? 'missing-mcp' : 'missing-cli';
				return { state, cli, python, detail: lastLine(msg), graphs, missing };
			}
		}
		return { state: 'ready', cli, server, python, graphs, missing };
	}

	// ---- Managed install -------------------------------------------------------------------------

	/** Asks once, then installs. Falls back to manual instructions where automatic install isn't possible. */
	async offerInstall(s: GraphStatus): Promise<boolean> {
		const reason = s.state === 'missing-mcp' ? 'The installed graphify has no MCP support.' : 'graphify is not installed.';
		if (!s.canInstall) {
			this.showInstallHint(reason);
			return false;
		}
		const choice = await vscode.window.showInformationMessage(
			`${reason} Install it automatically? The extension downloads uv and graphify from PyPI (plus Python, if none is installed) `
			+ 'into its own storage folder. Nothing is added to your PATH.',
			'Install', 'Install Manually…');
		if (choice === 'Install Manually…') { this.showInstallHint(reason); }
		return choice === 'Install' ? this.installManaged() : false;
	}

	/** Installs (or with `upgrade`, updates) the extension's own graphify. Concurrent calls share one install. */
	installManaged(upgrade = false): Promise<boolean> {
		if (!this.managed) { return Promise.resolve(false); }
		const managed = this.managed;
		return this.installing ??= (async () => {
			try {
				return await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: upgrade ? 'Updating graphify' : 'Installing graphify',
					cancellable: true,
				}, async (progress, token) => {
					const abort = new AbortController();
					const sub = token.onCancellationRequested(() => abort.abort());
					try {
						const cli = await managed.install({ report: message => progress.report({ message }) }, abort.signal, upgrade);
						this.log.info(`graphify ${upgrade ? 'updated' : 'installed'}: ${cli}`);
						void vscode.window.showInformationMessage(`graphify ${upgrade ? 'updated' : 'installed'}.`);
						return true;
					} catch (err) {
						if (abort.signal.aborted) { return false; }
						this.log.error(`graphify install failed: ${errorMessage(err)}`);
						void vscode.window.showErrorMessage(`Installing graphify failed: ${lastLine(errorMessage(err))}`, 'Show Log', 'Install Manually…')
							.then(c => {
								if (c === 'Show Log') { this.log.show(); }
								if (c === 'Install Manually…') { this.showInstallHint('Automatic install failed.'); }
							});
						return false;
					} finally {
						sub.dispose();
					}
				});
			} finally {
				this.installing = undefined;
				this.statusCache = undefined;
				this.refresh();
			}
		})();
	}

	async removeManaged(): Promise<void> {
		if (!this.managed || !await this.managed.installed()) {
			void vscode.window.showInformationMessage('The extension has not installed its own graphify.');
			return;
		}
		const ok = await vscode.window.showWarningMessage('Remove the graphify copy installed by this extension?', { modal: true }, 'Remove');
		if (ok !== 'Remove') { return; }
		this.lastSignature = '';
		this.statusCache = Promise.resolve({ state: 'missing-cli', graphs: [], missing: [] });
		this.changeEmitter.fire(); // stop offering the server before its files disappear
		try {
			await this.managed.remove();
			void vscode.window.showInformationMessage('graphify removed.');
		} catch (err) {
			void vscode.window.showErrorMessage(`Removing graphify failed (is a graphify server still running?): ${errorMessage(err)}`);
		}
		this.refresh();
	}

	private showInstallHint(reason: string) {
		void vscode.window.showWarningMessage(
			`${reason} Install it with: ${INSTALL_HINT}  (or set openrouterEnsemble.graph.command / graph.python)`,
			'Copy Command', 'Open Settings',
		).then(c => {
			if (c === 'Copy Command') { void vscode.env.clipboard.writeText(INSTALL_HINT); }
			if (c === 'Open Settings') { void vscode.commands.executeCommand('workbench.action.openSettings', 'openrouterEnsemble.graph'); }
		});
	}

	private async pickFolder(folders: vscode.WorkspaceFolder[]): Promise<vscode.WorkspaceFolder | undefined> {
		if (folders.length <= 1) { return folders[0]; }
		return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Build the knowledge graph for which folder?' });
	}

	/** execFile without a shell: arguments are never interpreted. */
	private exec(cmd: string, args: string[], cwd: string | undefined, token: vscode.CancellationToken | undefined, timeout: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
				(err, stdout, stderr) => {
					this.running.delete(child);
					if (err) { reject(new Error(`${String(stderr).trim() || err.message}`)); } else { resolve(`${stdout}\n${stderr}`); }
				});
			this.running.add(child);
			token?.onCancellationRequested(() => child.kill());
		});
	}
}

export function describe(s: GraphStatus): string {
	const install = s.canInstall ? ' — run "OpenRouter Ensemble: Install graphify" to install it automatically' : '';
	switch (s.state) {
		case 'disabled': return 'off';
		case 'untrusted': return 'off in restricted mode';
		case 'missing-cli': return `graphify not available (${s.detail ?? 'not found'})${install}`;
		case 'missing-mcp': return `graphify found at ${s.cli} but its MCP server can't start (${s.detail ?? ''})${install || `; install with ${INSTALL_HINT}`}`;
		case 'ready': {
			const via = s.managed ? 'the extension\'s own graphify' : s.server?.command;
			return s.graphs.length
				? `serving ${s.graphs.map(g => g.folder.name).join(', ')} via ${via}`
				: `ready (${via}), no graph built yet (run "OpenRouter Ensemble: Build Knowledge Graph")`;
		}
	}
}

/** Last non-empty line: for Python tracebacks that's the actual error. */
function lastLine(s: string) {
	return s.trim().split(/\r?\n/).filter(Boolean).pop() ?? s;
}

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}
