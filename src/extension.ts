import * as vscode from 'vscode';
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

	context.subscriptions.push(
		log,
		vscode.lm.registerLanguageModelChatProvider('openrouter-ensemble', provider),
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

	log.info('OpenRouter Ensemble provider registered');
}

export function deactivate() { }
