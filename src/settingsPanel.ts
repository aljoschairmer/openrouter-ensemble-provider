import * as vscode from 'vscode';
import type { EnsembleConfigRaw, RouterConfig } from './config';
import type { ORModel } from './openrouter';
import type { ModelStats } from './performance';
import { isChatModel, type OpenRouterEnsembleProvider } from './provider';

/** Shape exchanged with the webview. Mirrors the `openrouterEnsemble.*` settings. */
interface SettingsState {
	models: string[];
	ensembles: EnsembleConfigRaw[];
	routers: RouterConfig[];
	modelReasoning: Record<string, string>;
	fallbacks: Record<string, string[]>;
	general: {
		proposerTimeoutSeconds: number;
		proposerContextChars: number;
		logUsage: boolean;
		stickySessions: boolean;
		performanceMemory: boolean;
		extraBody: Record<string, unknown>;
	};
}

interface CatalogEntry {
	id: string;
	name: string;
	tools: boolean;
	image: boolean;
	context: number;
	priceIn: number | null;  // $ per 1M tokens
	priceOut: number | null;
	created: number;
	/** Reasoning levels the model accepts ([] = any / unknown); undefined = no reasoning support. */
	efforts?: string[];
	reasoningMandatory?: boolean;
}

type FromWebview =
	| { type: 'ready' }
	| { type: 'save'; state: SettingsState }
	| { type: 'saveKey'; key: string }
	| { type: 'removeKey' }
	| { type: 'refreshCatalog' }
	| { type: 'openLog' }
	| { type: 'openExternal'; url: string }
	| { type: 'resetPerf'; ensembleId?: string }
	| { type: 'saveManagementKey'; key: string }
	| { type: 'removeManagementKey' };

const SETTING_KEYS = ['models', 'ensembles', 'routers', 'modelReasoning', 'fallbacks', 'proposerTimeoutSeconds', 'proposerContextChars', 'logUsage', 'stickySessions', 'performanceMemory', 'extraBody'] as const;

export class SettingsPanel {
	private static current?: SettingsPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private perfTimer?: NodeJS.Timeout;

	static show(context: vscode.ExtensionContext, provider: OpenRouterEnsembleProvider, log: vscode.LogOutputChannel) {
		if (SettingsPanel.current) {
			SettingsPanel.current.panel.reveal();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'openrouterEnsemble.settings',
			'OpenRouter Ensemble',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			},
		);
		panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
		SettingsPanel.current = new SettingsPanel(panel, context, provider, log);
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly provider: OpenRouterEnsembleProvider,
		private readonly log: vscode.LogOutputChannel,
	) {
		panel.webview.html = this.html();
		this.disposables.push(
			panel.onDidDispose(() => this.dispose()),
			panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg).catch(err => {
				this.log.error(`Settings page: ${err?.message ?? err}`);
				void this.post({ type: 'error', message: err?.message ?? String(err) });
			})),
			// Keep the page in sync when settings are edited elsewhere (settings.json, other window)
			// Live performance updates while the page is open (throttled)
			...(provider.perf ? [provider.perf.onDidChange(() => {
				clearTimeout(this.perfTimer);
				this.perfTimer = setTimeout(() => void this.sendPerf(), 500);
			})] : []),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('openrouterEnsemble')) {
					void this.post({ type: 'config', state: readState(), overrides: workspaceOverrides() });
				}
			}),
		);
	}

	private async onMessage(msg: FromWebview) {
		switch (msg.type) {
			case 'ready':
				await this.post({ type: 'config', state: readState(), overrides: workspaceOverrides() });
				await this.sendKeyState();
				await this.sendCatalog(false);
				await this.sendPerf();
				await this.post({ type: 'mgmt', has: !!await this.provider.getManagementKey() });
				break;

			case 'saveManagementKey':
				try {
					const credits = await this.provider.storeManagementKey(msg.key);
					await this.post({ type: 'mgmt', has: true, balance: credits.total_credits - credits.total_usage });
				} catch (err: any) {
					await this.post({ type: 'mgmt', has: !!await this.provider.getManagementKey(), error: `OpenRouter rejected this management key (${err?.message ?? err}). Nothing was saved.` });
				}
				break;

			case 'removeManagementKey':
				await this.provider.clearManagementKey();
				await this.post({ type: 'mgmt', has: false });
				break;

			case 'resetPerf':
				this.provider.perf?.reset(msg.ensembleId);
				await this.sendPerf();
				break;

			case 'save': {
				const cfg = vscode.workspace.getConfiguration('openrouterEnsemble');
				const s = msg.state;
				const G = vscode.ConfigurationTarget.Global;
				await cfg.update('models', s.models, G);
				await cfg.update('ensembles', s.ensembles, G);
				await cfg.update('routers', s.routers, G);
				await cfg.update('modelReasoning', s.modelReasoning, G);
				await cfg.update('fallbacks', s.fallbacks, G);
				await cfg.update('proposerTimeoutSeconds', s.general.proposerTimeoutSeconds, G);
				await cfg.update('proposerContextChars', s.general.proposerContextChars, G);
				await cfg.update('logUsage', s.general.logUsage, G);
				await cfg.update('stickySessions', s.general.stickySessions, G);
				await cfg.update('performanceMemory', s.general.performanceMemory, G);
				await cfg.update('extraBody', s.general.extraBody, G);
				await this.post({ type: 'saved', state: readState() });
				break;
			}

			case 'saveKey':
				try {
					const info = await this.provider.storeApiKey(msg.key);
					await this.post({ type: 'key', has: true, info });
				} catch (err: any) {
					await this.post({ type: 'keySaveFailed', message: `OpenRouter rejected this key (${err?.message ?? err}). Nothing was saved.` });
				}
				break;

			case 'removeKey':
				await this.provider.clearApiKey();
				await this.post({ type: 'key', has: false });
				break;

			case 'refreshCatalog':
				await this.sendCatalog(true);
				break;

			case 'openLog':
				await vscode.commands.executeCommand('openrouterEnsemble.showLog');
				break;

			case 'openExternal':
				if (/^https:\/\/openrouter\.ai\//.test(msg.url)) {
					await vscode.env.openExternal(vscode.Uri.parse(msg.url));
				}
				break;
		}
	}

	private async sendKeyState() {
		if (!await this.provider.hasApiKey()) {
			return this.post({ type: 'key', has: false });
		}
		try {
			const info = await this.provider.client.getKeyInfo();
			await this.post({ type: 'key', has: true, info });
		} catch (err: any) {
			await this.post({ type: 'key', has: true, keyError: `The stored key could not be verified (${err?.message ?? err}).` });
		}
	}

	private async sendCatalog(force: boolean) {
		try {
			const models = await this.provider.getCatalog(force);
			await this.post({ type: 'catalog', catalog: models.filter(isChatModel).map(toCatalogEntry) });
		} catch (err: any) {
			await this.post({ type: 'catalog', catalog: [], catalogError: err?.message ?? String(err) });
		}
	}

	private sendPerf() {
		const perf = this.provider.perf;
		if (!perf) { return; }
		const byEnsemble: Record<string, ModelStats[]> = {};
		for (const e of vscode.workspace.getConfiguration('openrouterEnsemble').get<{ id: string }[]>('ensembles') ?? []) {
			byEnsemble[e.id] = perf.stats(e.id);
		}
		return this.post({ type: 'perf', total: perf.size, byEnsemble });
	}

	private post(message: unknown) {
		return this.panel.webview.postMessage(message);
	}

	private html(): string {
		const webview = this.panel.webview;
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${media('settings.css')}">
	<title>OpenRouter Ensemble</title>
</head>
<body>
	<div id="app" class="app" aria-busy="true"></div>
	<script nonce="${nonce}" src="${media('settings.js')}"></script>
</body>
</html>`;
	}

	private dispose() {
		SettingsPanel.current = undefined;
		clearTimeout(this.perfTimer);
		this.disposables.forEach(d => d.dispose());
	}
}

function readState(): SettingsState {
	const c = vscode.workspace.getConfiguration('openrouterEnsemble');
	return {
		models: c.get<string[]>('models') ?? [],
		ensembles: c.get<EnsembleConfigRaw[]>('ensembles') ?? [],
		routers: c.get<RouterConfig[]>('routers') ?? [],
		modelReasoning: c.get<Record<string, string>>('modelReasoning') ?? {},
		fallbacks: c.get<Record<string, string[]>>('fallbacks') ?? {},
		general: {
			proposerTimeoutSeconds: c.get<number>('proposerTimeoutSeconds') ?? 90,
			proposerContextChars: c.get<number>('proposerContextChars') ?? 120_000,
			logUsage: c.get<boolean>('logUsage') ?? true,
			stickySessions: c.get<boolean>('stickySessions') ?? true,
			performanceMemory: c.get<boolean>('performanceMemory') ?? true,
			extraBody: c.get<Record<string, unknown>>('extraBody') ?? {},
		},
	};
}

/** Settings that a workspace overrides — saving to user settings would have no visible effect there. */
function workspaceOverrides(): string[] {
	const c = vscode.workspace.getConfiguration('openrouterEnsemble');
	return SETTING_KEYS.filter(k => {
		const i = c.inspect(k);
		return i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined;
	});
}

function toCatalogEntry(m: ORModel): CatalogEntry {
	const perMillion = (v?: string) => {
		const n = Number(v);
		return v !== undefined && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
	};
	return {
		id: m.id,
		name: m.name,
		tools: !!m.supported_parameters?.includes('tools'),
		image: !!m.architecture?.input_modalities?.includes('image'),
		context: m.top_provider?.context_length ?? m.context_length ?? 0,
		priceIn: perMillion(m.pricing?.prompt),
		priceOut: perMillion(m.pricing?.completion),
		created: m.created ?? 0,
		efforts: m.supported_parameters?.includes('reasoning') ? (m.reasoning?.supported_efforts ?? []).flatMap(e => e ? [String(e)] : []) : undefined,
		reasoningMandatory: m.reasoning?.mandatory,
	};
}
