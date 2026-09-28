import * as vscode from 'vscode';
import * as path from 'node:path';
import { describe, GraphService, MCP_PROVIDER_ID } from './graph';
import { ManagedGraphify, proxyEnv } from './graphInstall';
import { PerformanceStore } from './performance';
import { OpenRouterEnsembleProvider } from './provider';
import { SettingsPanel } from './settingsPanel';
import { SidebarProvider } from './sidebar';
import { ActivityBus, UsageLedger } from './usage';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('OpenRouter Ensemble', { log: true });
	const perf = new PerformanceStore(context.globalState, log);
	const ledger = new UsageLedger(context.globalState);
	const bus = new ActivityBus(ledger);
	const provider = new OpenRouterEnsembleProvider(context.secrets, log, perf, ledger, bus);
	const sidebar = new SidebarProvider(context, provider, ledger, bus);
	// The extension's own graphify (installed on request): uv + graphify + Python if needed, all in global storage
	const managed = new ManagedGraphify(path.join(context.globalStorageUri.fsPath, 'graphify'), {
		env: () => proxyEnv(vscode.workspace.getConfiguration('http').get<string>('proxy')),
		log: m => log.info(m),
	});
	const graph = new GraphService(log, managed);

	context.subscriptions.push(
		log,
		graph,
		vscode.lm.registerLanguageModelChatProvider('openrouter-ensemble', provider),
		// graphify's MCP server: graph tools appear in options.tools for every model this provider serves
		vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, graph),
		vscode.commands.registerCommand('openrouterEnsemble.buildGraph', () => graph.build()),
		vscode.commands.registerCommand('openrouterEnsemble.installGraphify', () => graph.installManaged()),
		vscode.commands.registerCommand('openrouterEnsemble.updateGraphify', () => graph.installManaged(true)),
		vscode.commands.registerCommand('openrouterEnsemble.removeGraphify', () => graph.removeManaged()),
		vscode.commands.registerCommand('openrouterEnsemble.graphStatus', async () => {
			graph.refresh();
			const s = await graph.status();
			const actions = [
				...(s.state === 'ready' || s.state === 'disabled' ? ['Build Graph'] : []),
				...(s.canInstall ? ['Install graphify'] : []),
				'Show Log',
			];
			const choice = await vscode.window.showInformationMessage(`Knowledge graph: ${describe(s)}`, ...actions);
			if (choice === 'Build Graph') { await graph.build(); }
			if (choice === 'Install graphify') { await graph.installManaged(); }
			if (choice === 'Show Log') { log.show(); }
		}),
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
		vscode.commands.registerCommand('openrouterEnsemble.refreshDashboard', () => sidebar.refresh()),

		vscode.commands.registerCommand('openrouterEnsemble.setApiKey', () => provider.setApiKey()),
		vscode.commands.registerCommand('openrouterEnsemble.clearApiKey', async () => {
			await provider.clearApiKey();
			void vscode.window.showInformationMessage('OpenRouter API key removed.');
		}),
		vscode.commands.registerCommand('openrouterEnsemble.showLog', () => log.show()),
		vscode.commands.registerCommand('openrouterEnsemble.resetPerformance', async () => {
			const ok = await vscode.window.showWarningMessage('Forget all recorded model performance?', { modal: true }, 'Forget');
			if (ok) { perf.reset(); }
		}),

		// managementCommand from package.json → "Manage Models…" in the chat model picker opens the settings page
		vscode.commands.registerCommand('openrouterEnsemble.manage', () => SettingsPanel.show(context, provider, log)),

		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openrouterEnsemble.graph')) {
				graph.refresh();
				void graph.maybeSuggestBuild(context.workspaceState);
			}
			if (e.affectsConfiguration('openrouterEnsemble')) {
				provider.refresh();
			}
		}),
		context.secrets.onDidChange(e => {
			if (e.key === 'openrouterEnsemble.apiKey') {
				provider.refresh();
			}
			if (e.key === 'openrouterEnsemble.apiKey' || e.key === 'openrouterEnsemble.managementKey') {
				sidebar.refresh();
			}
		}),
	);

	graph.refresh();
	void graph.maybeSuggestBuild(context.workspaceState);
	log.info('OpenRouter Ensemble provider registered');
}

export function deactivate() { }
