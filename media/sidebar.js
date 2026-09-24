// @ts-check
/* OpenRouter Ensemble sidebar: spend, live activity, breakdowns. Plain DOM; data only via textContent. */
(function () {
	// @ts-ignore injected by VS Code
	const vscode = acquireVsCodeApi();
	const app = /** @type {HTMLElement} */ (document.getElementById('app'));
	const saved = vscode.getState() || {};

	/** @type {any} */ let usage = null;
	/** @type {any} */ let live = { active: [], last: null, now: Date.now() };
	let clockSkew = 0;
	let breakdown = saved.breakdown || 'model';
	/** @type {HTMLElement|null} */ let tooltip = null;

	const PALETTE = ['--vscode-charts-blue', '--vscode-charts-green', '--vscode-charts-yellow', '--vscode-charts-orange',
		'--vscode-charts-red', '--vscode-charts-purple', '--vscode-terminal-ansiCyan', '--vscode-terminal-ansiMagenta'];
	const FALLBACK = ['#3794ff', '#89d185', '#cca700', '#d18616', '#f14c4c', '#b180d7', '#29b8db', '#bc3fbc'];
	const STAGE_LABEL = {
		single: 'answer', final: 'final answer', explore: 'exploring', draft: 'draft', refine: 'revision',
		review: 'peer review', judge: 'judge', critique: 'critique', classifier: 'router rating',
	};
	const PHASE_LABEL = {
		routing: 'Choosing a model', exploring: 'Reading the code', drafting: 'Drafting', refining: 'Revising drafts',
		reviewing: 'Reviewing drafts', answering: 'Answering', done: 'Done', error: 'Failed', cancelled: 'Cancelled',
	};

	// --- helpers -----------------------------------------------------------------------------------

	/** @param {string} tag @param {Record<string, any>} [props] @param {...any} children */
	function h(tag, props = {}, ...children) {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (v === undefined || v === null || v === false) { continue; }
			if (k === 'text') { node.textContent = v; }
			else if (k === 'class') { node.className = v; }
			else if (k === 'style') { Object.assign(node.style, v); }
			else if (k.startsWith('on')) { node.addEventListener(k.slice(2).toLowerCase(), v); }
			else { node.setAttribute(k, v === true ? '' : String(v)); }
		}
		for (const c of children.flat()) {
			if (c === null || c === undefined || c === false) { continue; }
			node.append(typeof c === 'string' ? document.createTextNode(c) : c);
		}
		return node;
	}
	/** @param {string} tag @param {Record<string, any>} [attrs] */
	function s(tag, attrs = {}) {
		const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
		for (const [k, v] of Object.entries(attrs)) { node.setAttribute(k, String(v)); }
		return node;
	}
	/** @param {Element} box @param {...any} nodes */
	const fill = (box, ...nodes) => box.replaceChildren(...nodes.flat().filter(n => n !== null && n !== undefined && n !== false));
	const post = (/** @type {any} */ m) => vscode.postMessage(m);
	const persist = () => vscode.setState({ breakdown });

	/** @param {number|undefined|null} n */
	function usd(n) {
		if (n === undefined || n === null) { return '\u2013'; }
		if (n === 0) { return '$0'; }
		if (n < 0.01) { return `$${n.toFixed(4)}`; }
		if (n < 100) { return `$${n.toFixed(2)}`; }
		return `$${Math.round(n).toLocaleString('en-US')}`;
	}
	const fmtInt = (/** @type {number} */ n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
	const pct = (/** @type {number} */ x) => `${Math.round(x * 100)}%`;
	const secs = (/** @type {number} */ ms) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
	const shortModel = (/** @type {string} */ id) => {
		const name = usage?.names?.[id];
		if (name) { return name.replace(/^[^:]+:\s*/, ''); }
		return id.replace(/^~/, '').split('/').pop() || id;
	};
	/** Resolves a CSS custom property so SVG fills work in every theme. @param {number} i */
	function color(i) {
		const v = getComputedStyle(document.body).getPropertyValue(PALETTE[i % PALETTE.length]).trim();
		return v || FALLBACK[i % FALLBACK.length];
	}

	// --- render ------------------------------------------------------------------------------------

	function render() {
		if (!usage) { fill(app, h('p', { class: 'muted pad', text: 'Loading\u2026' })); return; }
		if (!usage.hasKey) {
			fill(app, h('section', { class: 'empty' },
				h('p', { text: 'Add your OpenRouter API key to use the models and see your spend here.' }),
				h('button', { class: 'btn', onclick: () => post({ type: 'command', command: 'openSettings' }) }, 'Open settings')));
			return;
		}
		fill(app, renderTotals(), h('div', { id: 'live' }), renderSpend(), renderBreakdown(), renderRecent(), renderFooter());
		renderLive();
	}

	function renderTotals() {
		const k = usage.key;
		const tiles = [
			['Today', k?.daily], ['This week', k?.weekly], ['This month', k?.monthly],
		].map(([label, v]) => h('div', { class: 'tile' }, h('span', { class: 'tile-label', text: label }), h('span', { class: 'tile-value', text: usd(v) })));

		/** @type {any} */ let meter = null;
		if (usage.credits) {
			const left = usage.credits.total - usage.credits.used;
			const ratio = usage.credits.total ? Math.max(0, Math.min(1, left / usage.credits.total)) : 0;
			meter = h('div', { class: 'meter-wrap' },
				h('div', { class: 'meter-text' }, h('span', { text: 'Account balance' }), h('strong', { text: usd(left) })),
				h('div', { class: `meter${ratio < 0.15 ? ' low' : ''}`, role: 'meter', 'aria-valuenow': Math.round(ratio * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Credits left' },
					h('div', { class: 'meter-fill', style: { width: `${ratio * 100}%` } })));
		} else if (k && k.limit != null) {
			const ratio = k.limit ? Math.max(0, Math.min(1, (k.limitRemaining ?? 0) / k.limit)) : 0;
			meter = h('div', { class: 'meter-wrap' },
				h('div', { class: 'meter-text' }, h('span', { text: 'Key limit left' }), h('strong', { text: `${usd(k.limitRemaining)} of ${usd(k.limit)}` })),
				h('div', { class: `meter${ratio < 0.15 ? ' low' : ''}`, role: 'meter', 'aria-valuenow': Math.round(ratio * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Key limit left' },
					h('div', { class: 'meter-fill', style: { width: `${ratio * 100}%` } })),
				k.limitReset ? h('div', { class: 'muted small', text: `Resets ${k.limitReset}` }) : null);
		}
		return h('section', { class: 'totals' },
			h('div', { class: 'tiles', title: 'Spend of this API key, from OpenRouter' }, tiles),
			usage.keyError ? h('p', { class: 'error small', text: `Couldn\u2019t load key totals: ${usage.keyError}` }) : null,
			meter);
	}

	function renderLive() {
		const box = document.getElementById('live');
		if (!box) { return; }
		const now = Date.now() + clockSkew;
		const runs = live.active || [];
		if (!runs.length) {
			const last = live.last;
			fill(box, h('section', { class: 'live idle' },
				h('div', { class: 'section-head' }, h('h2', { text: 'Now' }), h('span', { class: 'muted small', text: 'idle' })),
				last ? h('p', { class: 'muted small' },
					`Last: ${last.source.name} \u00b7 ${PHASE_LABEL[last.phase] || last.phase} \u00b7 ${secs((last.endedAt || now) - last.startedAt)} \u00b7 ${usd(last.cost)}`) : null));
			return;
		}
		fill(box, h('section', { class: 'live' },
			h('div', { class: 'section-head' }, h('h2', { text: 'Now' }), h('span', { class: 'pulse', 'aria-hidden': 'true' })),
			runs.map((/** @type {any} */ r) => h('div', { class: 'run' },
				h('div', { class: 'run-head' },
					h('strong', { text: r.source.name }),
					h('span', { class: 'muted small', text: `${secs(now - r.startedAt)} \u00b7 ${usd(r.cost)}` })),
				h('div', { class: 'run-phase' },
					h('span', { text: PHASE_LABEL[r.phase] || r.phase }),
					r.phase === 'drafting' && r.drafts?.length
						? h('span', { class: 'muted', text: ` \u00b7 ${r.drafts.filter((/** @type {any} */ d) => d.state !== 'pending').length} of ${r.drafts.length} drafts` })
						: r.detail ? h('span', { class: 'muted', text: ` \u00b7 ${r.detail}` }) : null,
					r.model && (r.phase === 'answering' || r.phase === 'exploring') ? h('span', { class: 'muted', text: ` \u00b7 ${shortModel(r.model)}` }) : null),
				r.route ? h('div', { class: 'chip-row' }, h('span', { class: 'chip route', title: 'Router decision', text: `${r.route.tier} \u2192 ${r.route.target.includes('/') ? shortModel(r.route.target) : r.route.target}` })) : null,
				r.drafts?.length ? h('ul', { class: 'drafts', 'aria-label': 'Drafts' }, r.drafts.map((/** @type {any} */ d) => h('li', { class: `draft ${d.state}` },
					h('span', { class: 'dot', 'aria-hidden': 'true' }),
					h('span', { class: 'draft-name', text: shortModel(d.model) }),
					h('span', { class: 'muted small', text: d.state === 'pending' ? 'writing\u2026' : d.state === 'ok' ? secs(d.ms || 0) : d.state === 'dropped' ? 'too slow' : 'failed' })))) : null,
			))));
	}

	function renderSpend() {
		const account = usage.view === 'account';
		const data = account ? usage.account : usage.local;
		const unavailable = account && (!usage.hasManagementKey || !data?.available);

		const seg = (/** @type {string} */ value, /** @type {string} */ label, /** @type {boolean} */ active, /** @type {() => void} */ on, /** @type {string} */ title) =>
			h('button', { class: `seg${active ? ' on' : ''}`, 'aria-pressed': String(active), title, onclick: on }, label);

		const controls = h('div', { class: 'controls' },
			h('div', { class: 'segmented', role: 'group', 'aria-label': 'Data source' },
				seg('extension', 'This extension', !account, () => post({ type: 'setView', view: 'extension' }), 'Every call made by this extension, split by ensemble and stage'),
				seg('account', 'Account', account, () => post({ type: 'setView', view: 'account' }), 'Your whole OpenRouter account, from OpenRouter (needs a management key)')),
			h('div', { class: 'segmented', role: 'group', 'aria-label': 'Time range' },
				seg('7', '7d', usage.range === 7, () => post({ type: 'setRange', range: 7 }), 'Last 7 days'),
				seg('30', '30d', usage.range === 30, () => post({ type: 'setRange', range: 30 }), 'Last 30 days')));

		if (unavailable) {
			return h('section', { class: 'spend' }, controls,
				h('p', { class: 'muted small' }, !usage.hasManagementKey
					? 'Account-wide spend needs an OpenRouter management key. It is only used to read usage, never for requests. '
					: `OpenRouter didn\u2019t return account data${data?.error ? `: ${data.error}` : ''}. `,
					h('button', { class: 'link', onclick: () => post({ type: 'command', command: 'openSettings' }) }, !usage.hasManagementKey ? 'Add one in settings' : 'Check settings')));
		}

		const total = data.totals.cost;
		return h('section', { class: 'spend' },
			controls,
			h('div', { class: 'headline' },
				h('span', { class: 'muted small', text: `Spend in last ${usage.range} days${account ? '' : ' through this extension'}` }),
				h('span', { class: 'big', text: usd(total) })),
			chart(data.daily, account),
			account ? h('p', { class: 'muted small', text: 'OpenRouter reports completed UTC days; today shows this key\u2019s running total.' }) : null);
	}

	/** Stacked bars per day, top models colored, the rest grouped. @param {any[]} daily @param {boolean} account */
	function chart(daily, account) {
		const totals = new Map();
		for (const d of daily) { for (const [m, v] of Object.entries(d.byModel)) { totals.set(m, (totals.get(m) || 0) + v); } }
		const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
		const top = ranked.slice(0, 7);
		const colorOf = (/** @type {string} */ m) => top.includes(m) ? color(top.indexOf(m)) : 'var(--vscode-descriptionForeground)';
		modelColors = new Map(top.map((m, i) => [m, color(i)]));

		const max = Math.max(...daily.map(d => d.total), 0);
		const W = 300, H = 118, TOP = 18, PADL = 0, GAP = daily.length > 14 ? 2 : 4;
		const bw = (W - PADL - GAP * (daily.length - 1)) / daily.length;
		const svg = s('svg', { viewBox: `0 0 ${W} ${H + 16}`, class: 'chart', role: 'img', 'aria-label': `Spend per day, highest ${usd(max)}` });

		if (!max) {
			const t = s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' });
			t.textContent = 'No spend in this period';
			svg.append(t);
		}
		// gridline at max
		if (max) {
			svg.append(s('line', { x1: 0, x2: W, y1: TOP, y2: TOP, class: 'grid' }));
			const lbl = s('text', { x: W, y: TOP - 5, 'text-anchor': 'end', class: 'axis' });
			lbl.textContent = usd(max);
			svg.append(lbl);
		}

		daily.forEach((d, i) => {
			const x = PADL + i * (bw + GAP);
			let y = H;
			const g = s('g', { class: 'bar', tabindex: '0' });
			const parts = Object.entries(d.byModel).filter(([, v]) => v > 0).sort((a, b) => ranked.indexOf(a[0]) - ranked.indexOf(b[0]));
			for (const [m, v] of parts) {
				const hgt = max ? Math.max(1, (v / max) * (H - TOP)) : 0;
				y -= hgt;
				g.append(s('rect', { x, y, width: Math.max(1, bw), height: hgt, fill: colorOf(m), class: d.partial ? 'partial' : '' }));
			}
			// full-height hit area for hover
			g.append(s('rect', { x, y: 0, width: Math.max(1, bw + GAP), height: H, fill: 'transparent' }));
			const show = (/** @type {Event} */ ev) => showTooltip(ev, d, colorOf);
			g.addEventListener('mouseenter', show);
			g.addEventListener('focus', show);
			g.addEventListener('mouseleave', hideTooltip);
			g.addEventListener('blur', hideTooltip);
			svg.append(g);
		});

		// first / last date labels
		if (daily.length) {
			const a = s('text', { x: 0, y: H + 13, class: 'axis' });
			a.textContent = shortDate(daily[0].date);
			const b = s('text', { x: W, y: H + 13, 'text-anchor': 'end', class: 'axis' });
			b.textContent = account ? 'today' : shortDate(daily[daily.length - 1].date);
			svg.append(a, b);
		}
		return h('div', { class: 'chart-wrap' }, svg);
	}
	/** @type {Map<string, string>} */ let modelColors = new Map();

	const shortDate = (/** @type {string} */ iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

	/** @param {Event} ev @param {any} d @param {(m: string) => string} colorOf */
	function showTooltip(ev, d, colorOf) {
		hideTooltip();
		const rows = Object.entries(d.byModel).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
		tooltip = h('div', { class: 'tooltip', role: 'tooltip' },
			h('div', { class: 'tt-head' }, h('strong', { text: shortDate(d.date) }), h('span', { text: usd(d.total) })),
			rows.length ? rows.map(([m, v]) => h('div', { class: 'tt-row' },
				h('span', { class: 'swatch', style: { background: colorOf(m) } }),
				h('span', { class: 'tt-name', text: m.startsWith('today') ? m : shortModel(m) }),
				h('span', { text: usd(v) }))) : h('div', { class: 'muted', text: 'No spend' }));
		document.body.append(tooltip);
		const target = /** @type {Element} */ (ev.currentTarget).getBoundingClientRect();
		const tw = tooltip.offsetWidth;
		const left = Math.max(4, Math.min(window.innerWidth - tw - 4, target.left + target.width / 2 - tw / 2));
		tooltip.style.left = `${left}px`;
		tooltip.style.top = `${Math.max(4, target.top - tooltip.offsetHeight - 6 + window.scrollY)}px`;
	}
	function hideTooltip() { tooltip?.remove(); tooltip = null; }

	function renderBreakdown() {
		const account = usage.view === 'account';
		if (account && !usage.account?.available) { return null; }
		const tabs = account ? [['model', 'Model']] : [['model', 'Model'], ['source', 'Ensemble'], ['stage', 'Stage']];
		const active = account ? 'model' : breakdown;
		const rows = account ? usage.account.byModel
			: active === 'source' ? usage.local.bySource
			: active === 'stage' ? usage.local.byStage
			: usage.local.byModel;

		const label = (/** @type {any} */ r) => active === 'model' ? shortModel(r.key) : active === 'stage' ? (STAGE_LABEL[r.key] || r.key) : r.label;
		const dotColor = (/** @type {any} */ r) => active === 'model' ? (modelColors.get(r.key) || 'var(--vscode-descriptionForeground)') : null;

		return h('section', { class: 'breakdown' },
			h('div', { class: 'section-head' },
				h('h2', { text: 'Breakdown' }),
				tabs.length > 1 ? h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, text]) => h('button', {
					class: `tab${active === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(active === id),
					onclick: () => { breakdown = id; persist(); render(); },
				}, text))) : null),
			rows.length ? h('ul', { class: 'rows' }, rows.slice(0, 12).map((/** @type {any} */ r) => h('li', { class: 'row', title: r.key },
				h('div', { class: 'row-top' },
					dotColor(r) ? h('span', { class: 'swatch', style: { background: dotColor(r) } }) : null,
					h('span', { class: 'row-name', text: label(r) }),
					h('span', { class: 'row-cost', text: usd(r.cost) })),
				h('div', { class: 'share' }, h('div', { class: 'share-fill', style: { width: `${Math.max(1, r.share * 100)}%`, background: dotColor(r) || '' } })),
				h('div', { class: 'row-meta muted small' },
					`${fmtInt(r.requests)} request${r.requests === 1 ? '' : 's'} \u00b7 ${fmtInt(r.tokens)} tokens`
					+ (r.cachedShare !== undefined && r.cachedShare > 0 ? ` \u00b7 ${pct(r.cachedShare)} cached` : '')
					+ ` \u00b7 ${pct(r.share)}`),
			))) : h('p', { class: 'muted small', text: account ? 'No activity reported for this period.' : 'Nothing yet. Pick an OpenRouter model or ensemble in the chat model picker to get started.' }));
	}

	function renderRecent() {
		if (usage.view === 'account') { return null; }
		const items = (usage.local.recent || []).slice(0, 10);
		if (!items.length) { return null; }
		return h('section', { class: 'recent' },
			h('h2', { text: 'Recent calls' }),
			h('ul', { class: 'rows' }, items.map((/** @type {any} */ e) => h('li', { class: 'row compact' },
				h('div', { class: 'row-top' },
					h('span', { class: 'row-name', text: shortModel(e.model) }),
					h('span', { class: 'row-cost', text: usd(e.cost) })),
				h('div', { class: 'row-meta muted small' },
					`${new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} \u00b7 ${STAGE_LABEL[e.stage] || e.stage} \u00b7 ${e.source.name}`
					+ ` \u00b7 ${fmtInt(e.promptTokens + e.completionTokens)} tok`
					+ (e.cachedTokens ? ` (${pct(e.cachedTokens / Math.max(1, e.promptTokens))} cached)` : '')),
			))));
	}

	function renderFooter() {
		return h('footer', { class: 'foot' },
			h('button', { class: 'link', onclick: () => post({ type: 'command', command: 'openSettings' }) }, 'Settings'),
			h('button', { class: 'link', onclick: () => post({ type: 'command', command: 'showLog' }) }, 'Log'),
			usage.view === 'extension' && usage.local.totals.requests ? h('button', { class: 'link', onclick: () => post({ type: 'command', command: 'resetUsage' }) }, 'Reset') : null);
	}

	// --- messages ----------------------------------------------------------------------------------

	window.addEventListener('message', ev => {
		const msg = ev.data;
		if (msg.type === 'usage') { usage = msg; render(); }
		if (msg.type === 'live') {
			live = msg;
			clockSkew = msg.now - Date.now();
			renderLive();
		}
	});
	// Keep elapsed times ticking while something runs
	setInterval(() => { if (live.active?.length) { renderLive(); } }, 1000);

	render();
	post({ type: 'ready' });
})();
