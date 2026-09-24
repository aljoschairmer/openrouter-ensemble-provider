import * as vscode from 'vscode';
import type { ORActivityItem, ORCredits, ORKeyInfo } from './openrouter';
import type { OpenRouterEnsembleProvider } from './provider';
import type { ActivityBus, UsageLedger, UsageSummary } from './usage';
import { utcDay } from './usage';

type Range = 7 | 30;
type View = 'extension' | 'account';

type FromWebview =
	| { type: 'ready' }
	| { type: 'setRange'; range: Range }
	| { type: 'setView'; view: View }
	| { type: 'refresh' }
	| { type: 'command'; command: 'openSettings' | 'showLog' | 'resetUsage' };

/** Account-wide activity reshaped like the local summary, so the webview renders both the same way. */
interface AccountSummary {
	available: boolean;
	error?: string;
	daily: { date: string; total: number; byModel: Record<string, number>; partial?: boolean }[];
	byModel: { key: string; label: string; requests: number; tokens: number; cost: number; share: number }[];
	totals: { cost: number; requests: number };
}

const KEY_TTL = 60_000;
const ACCOUNT_TTL = 10 * 60_000;

export class SidebarProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'openrouterEnsemble.dashboard';

	private view?: vscode.WebviewView;
	private range: Range = 30;
	private viewMode: View = 'extension';
	private keyCache?: { at: number; info?: ORKeyInfo; error?: string };
	private accountCache?: { at: number; activity?: ORActivityItem[]; credits?: ORCredits; error?: string };
	private usageTimer?: NodeJS.Timeout;
	private liveTimer?: NodeJS.Timeout;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly provider: OpenRouterEnsembleProvider,
		private readonly ledger: UsageLedger,
		private readonly bus: ActivityBus,
	) {
		context.subscriptions.push(
			ledger.onDidRecord(() => {
				this.keyCache = undefined; // spend changed; refresh key totals with the next update
				clearTimeout(this.usageTimer);
				this.usageTimer = setTimeout(() => void this.sendUsage(), 600);
			}),
			bus.onDidChange(() => {
				if (this.liveTimer) { return; }
				this.liveTimer = setTimeout(() => { this.liveTimer = undefined; void this.sendLive(); }, 150);
			}),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg));
		view.onDidChangeVisibility(() => { if (view.visible) { void this.sendAll(); } });
		view.onDidDispose(() => { this.view = undefined; });
	}

	/** Called from the view title's refresh action. */
	refresh() {
		this.keyCache = undefined;
		this.accountCache = undefined;
		void this.sendAll();
	}

	private async onMessage(msg: FromWebview) {
		switch (msg.type) {
			case 'ready': await this.sendAll(); break;
			case 'setRange': this.range = msg.range === 7 ? 7 : 30; await this.sendUsage(); break;
			case 'setView': this.viewMode = msg.view === 'account' ? 'account' : 'extension'; await this.sendUsage(); break;
			case 'refresh': this.refresh(); break;
			case 'command':
				if (msg.command === 'resetUsage') {
					const ok = await vscode.window.showWarningMessage('Forget the usage recorded by this extension? OpenRouter\u2019s own records are not affected.', { modal: true }, 'Forget');
					if (ok) { this.ledger.reset(); await this.sendUsage(); }
				} else {
					await vscode.commands.executeCommand(msg.command === 'openSettings' ? 'openrouterEnsemble.manage' : 'openrouterEnsemble.showLog');
				}
				break;
		}
	}

	private async sendAll() {
		await Promise.all([this.sendUsage(), this.sendLive()]);
	}

	private async sendLive() {
		if (!this.view?.visible) { return; }
		await this.view.webview.postMessage({ type: 'live', ...this.bus.snapshot(), now: Date.now() });
	}

	private async sendUsage() {
		if (!this.view?.visible) { return; }
		const hasKey = await this.provider.hasApiKey();
		const managementKey = await this.provider.getManagementKey();
		const [key, account] = await Promise.all([
			hasKey ? this.keyInfo() : Promise.resolve(undefined),
			managementKey ? this.account(managementKey) : Promise.resolve(undefined),
		]);

		const local: UsageSummary = this.ledger.summary(this.range);
		await this.view.webview.postMessage({
			type: 'usage',
			range: this.range,
			view: this.viewMode,
			hasKey,
			hasManagementKey: !!managementKey,
			key: key?.info ? {
				daily: key.info.usage_daily,
				weekly: key.info.usage_weekly,
				monthly: key.info.usage_monthly,
				limit: key.info.limit,
				limitRemaining: key.info.limit_remaining,
				limitReset: key.info.limit_reset,
			} : undefined,
			keyError: key?.error,
			credits: account?.credits ? { total: account.credits.total_credits, used: account.credits.total_usage } : undefined,
			local,
			account: managementKey ? this.accountSummary(account, key?.info) : undefined,
			names: this.modelNames(),
		});
	}

	private async keyInfo() {
		if (!this.keyCache || Date.now() - this.keyCache.at > KEY_TTL) {
			try {
				this.keyCache = { at: Date.now(), info: await this.provider.client.getKeyInfo() };
			} catch (err: any) {
				this.keyCache = { at: Date.now(), error: err?.message ?? String(err) };
			}
		}
		return this.keyCache;
	}

	private async account(managementKey: string) {
		if (!this.accountCache || Date.now() - this.accountCache.at > ACCOUNT_TTL) {
			try {
				const [activity, credits] = await Promise.all([
					this.provider.client.getActivity(managementKey),
					this.provider.client.getCredits(managementKey),
				]);
				this.accountCache = { at: Date.now(), activity, credits };
			} catch (err: any) {
				this.accountCache = { at: Date.now(), error: err?.message ?? String(err) };
			}
		}
		return this.accountCache;
	}

	/**
	 * OpenRouter's activity covers completed UTC days only. Today is added from the key's own daily
	 * total, marked partial, because it isn't split by model yet.
	 */
	private accountSummary(account: SidebarProvider['accountCache'], key?: ORKeyInfo): AccountSummary {
		if (!account || account.error || !account.activity) {
			return { available: false, error: account?.error, daily: [], byModel: [], totals: { cost: 0, requests: 0 } };
		}
		const now = Date.now();
		const dates: string[] = [];
		for (let i = this.range - 1; i >= 0; i--) { dates.push(utcDay(now - i * 86_400_000)); }
		const today = dates[dates.length - 1];

		const byDate = new Map(dates.map(d => [d, { date: d, total: 0, byModel: {} as Record<string, number>, partial: d === today }]));
		const models = new Map<string, { requests: number; tokens: number; cost: number }>();
		let cost = 0, requests = 0;
		for (const item of account.activity) {
			const day = byDate.get(item.date);
			if (!day) { continue; }
			day.byModel[item.model] = (day.byModel[item.model] ?? 0) + item.usage;
			day.total += item.usage;
			const m = models.get(item.model) ?? { requests: 0, tokens: 0, cost: 0 };
			m.requests += item.requests;
			m.tokens += item.prompt_tokens + item.completion_tokens;
			m.cost += item.usage;
			models.set(item.model, m);
			cost += item.usage;
			requests += item.requests;
		}
		const todayEntry = byDate.get(today)!;
		if (!todayEntry.total && key?.usage_daily) {
			todayEntry.byModel = { 'today (not split by model yet)': key.usage_daily };
			todayEntry.total = key.usage_daily;
			cost += key.usage_daily;
		}

		return {
			available: true,
			daily: [...byDate.values()],
			byModel: [...models.entries()]
				.map(([k, m]) => ({ key: k, label: k, ...m, share: cost ? m.cost / cost : 0 }))
				.sort((a, b) => b.cost - a.cost),
			totals: { cost, requests },
		};
	}

	private modelNames(): Record<string, string> {
		const names: Record<string, string> = {};
		for (const id of this.provider.registry.ids()) {
			names[id] = this.provider.registry.get(id)?.name ?? id;
		}
		return names;
	}

	private html(webview: vscode.Webview): string {
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${media('sidebar.css')}">
</head>
<body>
	<div id="app" aria-live="polite"></div>
	<script nonce="${nonce}" src="${media('sidebar.js')}"></script>
</body>
</html>`;
	}
}
