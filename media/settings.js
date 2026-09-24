// @ts-check
/* Settings page for OpenRouter Ensemble. Plain DOM, no framework; all user/remote data goes through textContent. */
(function () {
	// @ts-ignore acquireVsCodeApi is injected by VS Code
	const vscode = acquireVsCodeApi();
	const app = /** @type {HTMLElement} */ (document.getElementById('app'));
	const persisted = vscode.getState() || {};

	const DEFAULT_ENSEMBLE = {
		strategy: 'moa',
		proposers: [],
		aggregator: '~anthropic/claude-sonnet-latest',
		proposerReasoning: 'low',
		proposerMaxTokens: 4096,
		trigger: 'userTurns',
		graceSeconds: 10,
	};
	const DEFAULT_ROUTER = {
		classifier: '~openai/gpt-luna-latest',
		simple: '~google/gemini-flash-latest',
		standard: '~anthropic/claude-sonnet-latest',
		complex: '',
		useClassifier: true,
	};
	const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
	const STRATEGIES = {
		moa: { title: 'Mixture of agents', sub: 'Drafting models answer in parallel; the final model merges the best of their drafts.', stage: null },
		council: { title: 'Council', sub: 'Drafting models score each other\u2019s drafts with a correctness-weighted rubric (never their own). The final model gets the drafts ranked, with the issues reviewers found.', stage: 'peer review' },
		judge: { title: 'Judge', sub: 'One judge model scores all drafts in a single call. Cheaper than a council, with the same ranked input for the final model.', stage: 'judge' },
		plan: { title: 'Plan & build', sub: 'Drafting models write plans, not code: observations, approach, risks, how to verify. The final model merges them and carries out the work with tools. Best fit for agent mode.', stage: null },
	};

	/** @type {any} */ let state = null;
	let savedJson = '';
	let extraBodyText = '{}';
	/** @type {string[]} */ let overrides = [];
	let externalChange = false;

	/** @type {any[]} */ let catalog = [];
	/** @type {Map<string, any>} */ let byId = new Map();
	let catalogLoading = true;
	/** @type {string|null} */ let catalogError = null;

	let key = { loaded: false, has: false, /** @type {any} */ info: null, /** @type {string|null} */ error: null, checking: false, /** @type {string|null} */ saveError: null };

	let tab = persisted.tab || 'connection';
	let mgmt = { has: false, checking: false, /** @type {string|null} */ error: null, /** @type {number|null} */ balance: null };
	let selected = persisted.selected || 0;
	let selectedRouter = persisted.selectedRouter || 0;
	/** @type {{ total: number, byEnsemble: Record<string, any[]> }} */
	let perf = { total: 0, byEnsemble: {} };
	let confirmDeleteRouter = false;
	const filter = { q: '', toolsOnly: true, aliasesOnly: false };
	let saving = false;
	/** @type {{text: string, err?: boolean}|null} */ let flash = null;
	let confirmDelete = false;

	// ---------------------------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------------------------

	/**
	 * Creates an element. `text` sets textContent, `on*` adds listeners, everything else becomes an attribute/property.
	 * @param {string} tag @param {Record<string, any>} [props] @param {...any} children
	 */
	function h(tag, props = {}, ...children) {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (v === undefined || v === null || v === false) { continue; }
			if (k === 'text') { node.textContent = v; }
			else if (k === 'class') { node.className = v; }
			else if (k.startsWith('on')) { node.addEventListener(k.slice(2).toLowerCase(), v); }
			else if (k === 'value' || k === 'checked') { /** @type {any} */ (node)[k] = v; }
			else { node.setAttribute(k, v === true ? '' : String(v)); }
		}
		for (const c of children.flat()) {
			if (c === null || c === undefined || c === false) { continue; }
			node.append(typeof c === 'string' ? document.createTextNode(c) : c);
		}
		return node;
	}

	const SVG = 'http://www.w3.org/2000/svg';
	/** @param {string} tag @param {Record<string, any>} [attrs] */
	function s(tag, attrs = {}) {
		const node = document.createElementNS(SVG, tag);
		for (const [k, v] of Object.entries(attrs)) { node.setAttribute(k, String(v)); }
		return node;
	}

	const clone = (/** @type {any} */ v) => JSON.parse(JSON.stringify(v));
	/** replaceChildren() renders null as the text "null"; this skips empty entries. @param {Element} box @param {...any} nodes */
	const fill = (box, ...nodes) => box.replaceChildren(...nodes.flat().filter(n => n !== null && n !== undefined && n !== false));
	const shortId = (/** @type {string} */ id) => id.replace(/^~/, '').split('/').pop() || id;
	const fmtCtx = (/** @type {number} */ n) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
	const fmtPrice = (/** @type {number|null} */ n) => n === null ? '?' : n === 0 ? 'free' : `$${n < 1 ? +n.toFixed(3) : +n.toFixed(2)}`;
	const post = (/** @type {any} */ msg) => vscode.postMessage(msg);
	const persist = () => vscode.setState({ tab, selected, selectedRouter });

	/** Settings as they will be written: compact proposers, no empty optional fields. */
	function currentPayload() {
		const payload = clone(state);
		try { payload.general.extraBody = JSON.parse(extraBodyText || '{}'); } catch { /* validated separately */ }
		payload.ensembles = payload.ensembles.map((/** @type {any} */ e) => {
			const out = { ...e };
			out.proposers = e.proposers.map((/** @type {any} */ p) => {
				const q = { model: p.model };
				if (p.temperature !== undefined && p.temperature !== '' && p.temperature !== null) { q.temperature = Number(p.temperature); }
				if (p.reasoning) { q.reasoning = p.reasoning; }
				if (p.role && p.role.trim()) { q.role = p.role.trim(); }
				return Object.keys(q).length === 1 ? p.model : q;
			});
			for (const k of ['aggregatorReasoning', 'proposerReasoning', 'judge', 'quorum']) {
				if (out[k] === '' || out[k] === undefined || out[k] === null) { delete out[k]; }
			}
			for (const k of ['critique', 'refine', 'reread']) { if (!out[k]) { delete out[k]; } }
			return out;
		});
		for (const [k, v] of Object.entries(payload.modelReasoning)) { if (!v) { delete payload.modelReasoning[k]; } }
		for (const [k, v] of Object.entries(payload.fallbacks)) { if (!(/** @type {string[]} */ (v)).length) { delete payload.fallbacks[k]; } }
		return payload;
	}

	const isDirty = () => !!state && (
		JSON.stringify(currentPayload()) !== savedJson ||
		// unparseable JSON never matches the saved state
		extraBodyError() !== null
	);

	// ---------------------------------------------------------------------------------------------
	// Validation
	// ---------------------------------------------------------------------------------------------

	function extraBodyError() {
		try {
			const v = JSON.parse(extraBodyText || '{}');
			return v && typeof v === 'object' && !Array.isArray(v) ? null : 'Must be a JSON object, like {"provider": {…}}.';
		} catch (e) {
			return `Not valid JSON: ${/** @type {Error} */ (e).message}`;
		}
	}

	const knownModel = (/** @type {string} */ id) => catalogLoading || !catalog.length || byId.has(id);
	const allIds = () => [...state.ensembles.map((/** @type {any} */ e) => e.id), ...state.routers.map((/** @type {any} */ r) => r.id)];

	/** @param {any} ens @param {number} index */
	function ensembleIssues(ens, index) {
		/** @type {{text: string, err: boolean}[]} */
		const out = [];
		const err = (/** @type {string} */ text) => out.push({ text, err: true });
		const warn = (/** @type {string} */ text) => out.push({ text, err: false });

		if (!ens.name?.trim()) { err('Give the ensemble a name.'); }
		if (!/^[a-z0-9][a-z0-9-_]*$/i.test(ens.id || '')) { err('The ID may only contain letters, numbers, "-" and "_".'); }
		else if (allIds().filter(id => id === ens.id).length > 1) { err(`Another ensemble or router already uses the ID "${ens.id}".`); }
		if (!ens.aggregator?.trim()) { err('Choose a final model.'); }
		if (!ens.proposers?.length) { err('Add at least one drafting model.'); }
		for (const p of ens.proposers) {
			if (p.temperature !== undefined && p.temperature !== '' && !(Number(p.temperature) >= 0 && Number(p.temperature) <= 2)) {
				err(`Temperature for ${p.model} must be between 0 and 2.`);
			}
		}
		const models = new Set(ens.proposers.map((/** @type {any} */ p) => p.model));
		if (ens.strategy === 'council' && ens.proposers.length >= 2 && models.size === 1) {
			warn('All drafts come from one model, so nobody can review without judging their own work. The judge model reviews instead.');
		}
		if (ens.quorum && Number(ens.quorum) > ens.proposers.length) { warn(`The quorum (${ens.quorum}) is larger than the number of drafting models; all drafts will be awaited.`); }

		if (!catalogLoading && catalog.length) {
			const agg = byId.get(ens.aggregator);
			if (ens.aggregator && !agg) { warn(`Final model "${ens.aggregator}" is not on OpenRouter. The ensemble will be hidden.`); }
			else if (agg && !agg.tools) { warn(`${agg.name} can't call tools, so this ensemble won't work in agent mode.`); }
			if (ens.judge && !byId.has(ens.judge)) { warn(`Judge model "${ens.judge}" is not on OpenRouter.`); }
			for (const m of models) { if (!byId.has(m)) { warn(`Drafting model "${m}" is not on OpenRouter and will be skipped.`); } }
		}
		return out;
	}

	/** @param {any} r @param {number} index */
	function routerIssues(r, index) {
		/** @type {{text: string, err: boolean}[]} */
		const out = [];
		const err = (/** @type {string} */ text) => out.push({ text, err: true });
		const warn = (/** @type {string} */ text) => out.push({ text, err: false });
		if (!r.name?.trim()) { err('Give the router a name.'); }
		if (!/^[a-z0-9][a-z0-9-_]*$/i.test(r.id || '')) { err('The ID may only contain letters, numbers, "-" and "_".'); }
		else if (allIds().filter(id => id === r.id).length > 1) { err(`Another ensemble or router already uses the ID "${r.id}".`); }
		for (const t of ['simple', 'standard', 'complex']) {
			const target = r[t] || '';
			if (!target.trim()) { err(`Choose a target for ${t} requests.`); continue; }
			if (target.startsWith('ensemble:')) {
				if (!state.ensembles.some((/** @type {any} */ e) => `ensemble:${e.id}` === target)) { err(`${t}: there is no ensemble "${target.slice(9)}".`); }
			} else if (!knownModel(target)) {
				warn(`${t}: "${target}" is not on OpenRouter. Requests will escalate to the next level.`);
			} else if (byId.get(target) && !byId.get(target).tools) {
				warn(`${t}: ${byId.get(target).name} can't call tools; agent-mode requests skip to the next level.`);
			}
		}
		if (r.useClassifier && r.classifier && !knownModel(r.classifier)) { warn(`Classifier "${r.classifier}" is not on OpenRouter; heuristics will be used.`); }
		return out;
	}

	function allErrors() {
		const errors = [];
		if (!state) { return errors; }
		state.ensembles.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
			for (const issue of ensembleIssues(e, i)) { if (issue.err) { errors.push(`${e.name || 'Unnamed ensemble'}: ${issue.text}`); } }
		});
		state.routers.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
			for (const issue of routerIssues(r, i)) { if (issue.err) { errors.push(`${r.name || 'Unnamed router'}: ${issue.text}`); } }
		});
		if (extraBodyError()) { errors.push('Advanced: extra request fields are not valid JSON.'); }
		const g = state.general;
		if (!(g.proposerTimeoutSeconds > 0)) { errors.push('Advanced: draft timeout must be greater than 0.'); }
		if (!(g.proposerContextChars >= 1000)) { errors.push('Advanced: conversation length must be at least 1,000 characters.'); }
		return errors;
	}

	/** Mirrors config.callsPerMessage in the extension. @param {any} e */
	function callsPerMessage(e) {
		const n = e.proposers.length;
		let calls = n + 1;
		if (e.refine) { calls += n; }
		if (e.strategy === 'council' && n >= 2) { calls += n; }
		if (e.strategy === 'judge') { calls += 1; }
		if (e.critique && (e.strategy === 'moa' || e.strategy === 'plan')) { calls += 1; }
		return calls;
	}

	/**
	 * Reasoning dropdown limited to what the model accepts.
	 * @param {string} model @param {string|undefined} value @param {(v: string) => void} onChange @param {string} defaultLabel @param {string} [id]
	 */
	function effortSelect(model, value, onChange, defaultLabel, id) {
		const m = byId.get(model);
		const supported = m && m.efforts !== undefined ? (m.efforts.length ? m.efforts : EFFORTS) : EFFORTS;
		const none = m && m.efforts === undefined;
		const opts = EFFORTS.filter(e => supported.includes(e) && !(m?.reasoningMandatory && e === 'none'));
		return h('select', {
			id, class: 'effort', disabled: none, title: none ? 'This model has no reasoning setting' : 'Reasoning effort',
			'aria-label': 'Reasoning effort',
			onchange: (/** @type {any} */ e) => onChange(e.target.value),
		},
			h('option', { value: '', selected: !value ? true : null }, none ? 'no reasoning' : defaultLabel),
			opts.map(e => h('option', { value: e, selected: value === e ? true : null }, e)),
			value && !opts.includes(value) && !none ? h('option', { value, selected: true }, `${value} (mapped)`) : null,
		);
	}

	// ---------------------------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------------------------

	function render() {
		if (!state) {
			fill(app, h('div', { class: 'content' }, h('p', { class: 'lede', text: 'Loading settings…' })));
			return;
		}
		app.removeAttribute('aria-busy');
		const scrollY = window.scrollY;
		fill(app, renderNav(), renderContent(), renderFooter());
		window.scrollTo(0, scrollY);
	}

	function renderNav() {
		const tabs = [
			{ id: 'connection', label: 'Connection', extra: h('span', { class: `dot ${key.error ? 'err' : key.has ? 'ok' : ''}`, title: key.has ? 'API key configured' : 'No API key' }) },
			{ id: 'models', label: 'Models', extra: h('span', { class: 'count', text: state.models.includes('*') ? 'all' : String(state.models.length) }) },
			{ id: 'ensembles', label: 'Ensembles', extra: h('span', { class: 'count', text: String(state.ensembles.length) }) },
			{ id: 'routers', label: 'Routers', extra: h('span', { class: 'count', text: String(state.routers.length) }) },
			{ id: 'advanced', label: 'Advanced', extra: null },
		];
		return h('nav', { class: 'nav', 'aria-label': 'Settings sections' },
			h('div', { class: 'nav-title' }, 'OpenRouter Ensemble', h('small', { text: 'Models for Copilot Chat' })),
			tabs.map(t => h('button', {
				'aria-current': tab === t.id ? 'page' : null,
				onclick: () => { tab = t.id; confirmDelete = false; persist(); render(); },
			}, h('span', { text: t.label }), t.extra)),
		);
	}

	function renderContent() {
		const view = { connection: viewConnection, models: viewModels, ensembles: viewEnsembles, routers: viewRouters, advanced: viewAdvanced }[tab] || viewConnection;
		return h('main', { class: 'content' },
			overrides.length ? h('p', { class: 'banner' },
				`This workspace overrides ${overrides.join(', ')}. Changes here are saved to your user settings and won't apply in this workspace until you remove the override.`) : null,
			externalChange ? h('p', { class: 'banner' }, 'Settings were changed outside this page. Discard your edits to load them, or save to overwrite them.') : null,
			view(),
		);
	}

	function renderFooter() {
		const errors = allErrors();
		const dirty = isDirty();
		let text = 'All changes saved';
		let cls = 'state';
		if (flash) { text = flash.text; cls += flash.err ? ' err' : ''; }
		else if (dirty && errors.length) { text = errors.length === 1 ? errors[0] : `Fix ${errors.length} issues before saving. First: ${errors[0]}`; cls += ' err'; }
		else if (dirty) { text = 'Unsaved changes'; cls += ' dirty'; }

		return h('footer', { class: 'footer' },
			h('span', { class: cls, role: 'status', text }),
			h('div', { class: 'row' },
				h('button', { class: 'btn secondary', disabled: !dirty || saving, onclick: discard }, 'Discard'),
				h('button', { class: 'btn', disabled: !dirty || saving || errors.length > 0, onclick: save }, saving ? 'Saving…' : 'Save changes'),
			),
		);
	}

	function refreshFooter() {
		const footer = app.querySelector('footer');
		if (footer) { footer.replaceWith(renderFooter()); }
		const nav = app.querySelector('nav');
		if (nav) { nav.replaceWith(renderNav()); }
	}

	// --- Connection ------------------------------------------------------------------------------

	function viewConnection() {
		const input = /** @type {HTMLInputElement} */ (h('input', {
			type: 'password', id: 'api-key', placeholder: 'sk-or-v1-…', autocomplete: 'off', spellcheck: 'false',
			oninput: () => { saveBtn.disabled = !input.value.trim().startsWith('sk-or-') || key.checking; },
			onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !saveBtn.disabled) { saveKey(); } },
		}));
		const saveKey = () => {
			key.checking = true;
			key.saveError = null;
			post({ type: 'saveKey', key: input.value.trim() });
			render();
		};
		const saveBtn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', disabled: true, onclick: saveKey }, key.checking ? 'Checking key…' : key.has ? 'Replace key' : 'Save key'));

		/** @type {any} */ let status;
		if (!key.loaded) {
			status = h('div', { class: 'status' }, h('span', { class: 'dot' }), h('span', { text: 'Checking your key…' }));
		} else if (key.has && !key.error) {
			const i = key.info || {};
			const facts = [];
			if (i.label) { facts.push(h('span', { text: `Key: ${i.label}` })); }
			if (typeof i.usage === 'number') { facts.push(h('span', { text: `Used: $${i.usage.toFixed(2)}` })); }
			facts.push(h('span', { text: i.limit == null ? 'No spending limit' : `Remaining: $${Number(i.limit_remaining ?? 0).toFixed(2)} of $${Number(i.limit).toFixed(2)}` }));
			if (i.is_free_tier) { facts.push(h('span', { text: 'Free tier' })); }
			status = h('div', { class: 'status' }, h('span', { class: 'dot ok' }), h('strong', { text: 'Connected to OpenRouter' }), h('div', { class: 'facts' }, facts));
		} else if (key.has) {
			status = h('div', { class: 'status' }, h('span', { class: 'dot err' }), h('strong', { text: 'Key stored, but it could not be verified' }), h('div', { class: 'facts' }, h('span', { text: key.error || '' })));
		} else {
			status = h('div', { class: 'status' }, h('span', { class: 'dot' }), h('strong', { text: 'No API key yet' }),
				h('div', { class: 'facts' }, h('span', { text: 'OpenRouter models stay hidden in the chat model picker until you add one.' })));
		}

		return h('section', {},
			h('h1', { text: 'Connection' }),
			h('p', { class: 'lede', text: 'Requests go straight from VS Code to OpenRouter with your own key. The key is kept in VS Code\u2019s secret storage, never in settings files.' }),
			status,
			h('div', { class: 'field' },
				h('label', { for: 'api-key', text: key.has ? 'Replace API key' : 'API key' }),
				h('div', { class: 'row' }, input, saveBtn),
				key.saveError ? h('p', { class: 'error-text', role: 'alert', text: key.saveError }) : null,
				h('p', { class: 'help' }, 'Don\u2019t have one? ',
					h('button', { class: 'link', onclick: () => post({ type: 'openExternal', url: 'https://openrouter.ai/settings/keys' }) }, 'Create a key on openrouter.ai'),
					'. Setting a credit limit on the key is a good idea for ensembles.'),
			),
			key.has ? h('div', { class: 'field' },
				h('button', { class: 'btn secondary', onclick: () => post({ type: 'removeKey' }) }, 'Remove key'),
			) : null,
			viewManagementKey(),
		);
	}

	function viewManagementKey() {
		const input = /** @type {HTMLInputElement} */ (h('input', {
			type: 'password', id: 'mgmt-key', placeholder: 'sk-or-v1-\u2026', autocomplete: 'off', spellcheck: 'false',
			oninput: () => { btn.disabled = !input.value.trim().startsWith('sk-or-') || mgmt.checking; },
			onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !btn.disabled) { saveMgmt(); } },
		}));
		const saveMgmt = () => { mgmt.checking = true; mgmt.error = null; post({ type: 'saveManagementKey', key: input.value.trim() }); render(); };
		const btn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn secondary', disabled: true, onclick: saveMgmt }, mgmt.checking ? 'Checking\u2026' : mgmt.has ? 'Replace' : 'Save'));
		return h('div', { class: 'field' },
			h('h2', { text: 'Account-wide usage (optional)' }),
			h('p', { class: 'help', text: 'The sidebar always shows what this extension spends. To also see your whole OpenRouter account per model and your credit balance, add a management key. The extension only uses it to read usage and credits, never to call models or change keys. Management keys can manage your API keys, so keep it private.' }),
			mgmt.has ? h('p', {}, h('span', { class: 'dot ok' }), ' Management key saved', mgmt.balance !== null ? ` \u00b7 balance $${mgmt.balance.toFixed(2)}` : '') : null,
			h('label', { for: 'mgmt-key', text: mgmt.has ? 'Replace management key' : 'Management key' }),
			h('div', { class: 'row' }, input, btn,
				mgmt.has ? h('button', { class: 'btn danger', onclick: () => post({ type: 'removeManagementKey' }) }, 'Remove') : null),
			mgmt.error ? h('p', { class: 'error-text', role: 'alert', text: mgmt.error }) : null,
			h('p', { class: 'help' }, 'Create one under ',
				h('button', { class: 'link', onclick: () => post({ type: 'openExternal', url: 'https://openrouter.ai/settings/management-keys' }) }, 'Management keys on openrouter.ai'), '.'),
		);
	}

	// --- Models ----------------------------------------------------------------------------------

	function viewModels() {
		const all = state.models.includes('*');
		const toolCount = catalog.filter(m => m.tools).length;

		const listBox = h('div', { class: 'catalog', id: 'catalog', role: 'group', 'aria-label': 'OpenRouter models' });
		const countText = h('span', { class: 'help', id: 'catalog-count' });

		const section = h('section', {},
			h('h1', { text: 'Models in the picker' }),
			h('p', { class: 'lede', text: 'Each model you pick here appears on its own in the chat model picker. IDs starting with ~ and ending in -latest always point to the newest version of that model line.' }),
			h('label', { class: 'check field' },
				h('input', {
					type: 'checkbox', checked: all,
					onchange: (/** @type {any} */ e) => { state.models = e.target.checked ? ['*'] : []; render(); },
				}),
				h('span', { text: `Show every tool-capable model${catalog.length ? ` (${toolCount})` : ''}` }),
			),
		);

		if (all) {
			section.append(h('p', { class: 'help', text: 'The picker lists every OpenRouter model that supports tool calling. Turn this off to pick models individually.' }));
			return section;
		}

		section.append(
			h('h2', { text: `Selected (${state.models.length})` }),
			state.models.length
				? h('div', { class: 'rows' }, state.models.map((/** @type {string} */ id) => modelRow(id)))
				: h('p', { class: 'help', text: 'Nothing selected. Only your ensembles and routers will appear in the picker.' }),
			state.models.length ? h('p', { class: 'help', text: 'Reasoning applies wherever the model is used without its own setting, including inside ensembles and routers. Fallbacks are tried by OpenRouter when the model is down or rate-limited.' }) : null,
			h('h2', { text: 'Available on OpenRouter' }),
			h('div', { class: 'filters' },
				h('input', {
					type: 'search', placeholder: 'Filter by name or ID', value: filter.q, 'aria-label': 'Filter models',
					oninput: (/** @type {any} */ e) => { filter.q = e.target.value; renderCatalog(listBox, countText); },
				}),
				h('label', { class: 'check' }, h('input', {
					type: 'checkbox', checked: filter.toolsOnly,
					onchange: (/** @type {any} */ e) => { filter.toolsOnly = e.target.checked; renderCatalog(listBox, countText); },
				}), 'Tool-capable only'),
				h('label', { class: 'check' }, h('input', {
					type: 'checkbox', checked: filter.aliasesOnly,
					onchange: (/** @type {any} */ e) => { filter.aliasesOnly = e.target.checked; renderCatalog(listBox, countText); },
				}), '-latest aliases only'),
				h('button', { class: 'link', onclick: () => { catalogLoading = true; post({ type: 'refreshCatalog' }); render(); } }, 'Reload list'),
			),
			countText,
			listBox,
			modelDatalist(),
		);
		renderCatalog(listBox, countText);
		return section;
	}

	/** Shared autocomplete list of tool-capable models. @param {boolean} [withEnsembles] */
	function modelDatalist(withEnsembles = false) {
		return h('datalist', { id: withEnsembles ? 'target-options' : 'model-options' },
			withEnsembles ? state.ensembles.map((/** @type {any} */ e) => h('option', { value: `ensemble:${e.id}`, text: e.name })) : null,
			catalog.filter(m => m.tools).map(m => h('option', { value: m.id, text: m.name })));
	}

	/** @param {HTMLElement} box @param {HTMLElement} countText */
	function renderCatalog(box, countText) {
		if (catalogLoading) { fill(box, h('div', { class: 'empty', text: 'Loading models from OpenRouter…' })); countText.textContent = ''; return; }
		if (catalogError) { fill(box, h('div', { class: 'empty', text: `Couldn't load the model list: ${catalogError}` })); countText.textContent = ''; return; }

		const q = filter.q.trim().toLowerCase();
		const rows = catalog
			.filter(m => (!filter.toolsOnly || m.tools) && (!filter.aliasesOnly || m.id.startsWith('~')))
			.filter(m => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
			.sort((a, b) => (+b.id.startsWith('~') - +a.id.startsWith('~')) || (b.created - a.created));

		const LIMIT = 250;
		countText.textContent = rows.length > LIMIT
			? `Showing ${LIMIT} of ${rows.length}. Refine the filter to see the rest.`
			: `${rows.length} model${rows.length === 1 ? '' : 's'}`;

		if (!rows.length) { fill(box, h('div', { class: 'empty', text: 'No models match this filter.' })); return; }

		fill(box, ...rows.slice(0, LIMIT).map(m => {
			const checked = state.models.includes(m.id);
			return h('label', { class: 'model-row' },
				h('input', {
					type: 'checkbox', checked,
					onchange: (/** @type {any} */ e) => {
						state.models = e.target.checked ? [...state.models, m.id] : state.models.filter((/** @type {string} */ x) => x !== m.id);
						// Re-render the whole view so the selected chips update; keep search focus
						render();
						/** @type {HTMLInputElement|null} */ (app.querySelector('input[type="search"]'))?.focus({ preventScroll: true });
					},
				}),
				h('span', { class: 'name' },
					h('span', { text: m.name }),
					m.id.startsWith('~') ? h('span', { class: 'tag', text: 'auto-updates' }) : null,
					!m.tools ? h('span', { class: 'tag', text: 'no tools' }) : null,
					h('code', { class: 'id', text: m.id }),
				),
				h('span', { class: 'num', title: 'Context window', text: fmtCtx(m.context) }),
				h('span', { class: 'num', title: 'Price per 1M tokens, input / output', text: `${fmtPrice(m.priceIn)} / ${fmtPrice(m.priceOut)}` }),
			);
		}));
	}

	/** A selected model with its reasoning level and fallbacks. @param {string} id */
	function modelRow(id) {
		const m = byId.get(id);
		const unknown = !knownModel(id);
		const fallbacks = (state.fallbacks[id] || []).join(', ');
		return h('div', { class: `row-item${unknown ? ' warn' : ''}` },
			h('div', { class: 'row-main' },
				h('span', { text: m?.name || id }),
				h('code', { class: 'id', text: unknown ? `${id} (not on OpenRouter)` : id }),
			),
			effortSelect(id, state.modelReasoning[id], v => { state.modelReasoning[id] = v; refreshFooter(); }, 'default reasoning'),
			h('input', {
				type: 'text', class: 'fallbacks mono', list: 'model-options', value: fallbacks, spellcheck: 'false',
				placeholder: 'Fallbacks, comma-separated', 'aria-label': `Fallback models for ${id}`,
				oninput: (/** @type {any} */ e) => {
					state.fallbacks[id] = e.target.value.split(',').map((/** @type {string} */ x) => x.trim()).filter(Boolean);
					refreshFooter();
				},
			}),
			h('button', {
				class: 'icon-btn', 'aria-label': `Remove ${id}`, title: 'Remove',
				onclick: () => { state.models = state.models.filter((/** @type {string} */ x) => x !== id); render(); },
			}, '\u00d7'),
		);
	}

	/** @param {string} id @param {() => void} onRemove */
	function chip(id, onRemove) {
		const unknown = !catalogLoading && catalog.length > 0 && !byId.has(id);
		return h('span', { class: `chip${unknown ? ' warn' : ''}`, title: unknown ? 'Not found on OpenRouter' : (byId.get(id)?.name || id) },
			id,
			h('button', { 'aria-label': `Remove ${id}`, onclick: onRemove, text: '\u00d7' }),
		);
	}

	// --- Ensembles -------------------------------------------------------------------------------

	function viewEnsembles() {
		const list = state.ensembles;
		if (selected >= list.length) { selected = Math.max(0, list.length - 1); }

		const addEnsemble = () => {
			let n = list.length + 1;
			while (allIds().includes(`ensemble-${n}`)) { n++; }
			list.push({ id: `ensemble-${n}`, name: `Ensemble ${n}`, ...clone(DEFAULT_ENSEMBLE) });
			selected = list.length - 1;
			confirmDelete = false;
			persist();
			render();
			/** @type {HTMLInputElement|null} */ (app.querySelector('#ens-name'))?.select();
		};

		const section = h('section', {},
			h('h1', { text: 'Ensembles' }),
			h('p', { class: 'lede', text: 'An ensemble appears as one model in the picker. Every request goes to all drafting models at once; the final model reads their drafts, writes the answer and runs any tools.' }),
		);

		if (!list.length) {
			section.append(h('div', { class: 'status' },
				h('span', { class: 'dot' }),
				h('strong', { text: 'No ensembles yet' }),
				h('div', { class: 'facts' }, h('span', { text: 'Add one to have several models work on each request.' })),
			), h('button', { class: 'btn', onclick: addEnsemble }, 'Add ensemble'));
			return section;
		}

		section.append(
			h('div', { class: 'ens-list' }, list.map((/** @type {any} */ e, /** @type {number} */ i) => {
				const errs = ensembleIssues(e, i).filter(x => x.err).length;
				return h('button', {
					class: 'ens-item', 'aria-pressed': String(i === selected),
					onclick: () => { selected = i; confirmDelete = false; persist(); render(); },
				},
					h('strong', { text: e.name || 'Unnamed ensemble' }),
					errs ? h('span', { class: 'issue', text: `${errs} issue${errs > 1 ? 's' : ''}` }) : null,
					h('span', { class: 'sub', text: `${STRATEGIES[e.strategy || 'moa'].title}: ${e.proposers.length} drafting, final by ${e.aggregator ? shortId(e.aggregator) : '(not set)'}` }),
				);
			})),
			h('button', { class: 'btn secondary', onclick: addEnsemble }, 'Add ensemble'),
			renderEditor(list[selected], selected),
		);
		return section;
	}

	/** @param {any} ens @param {number} index */
	function renderEditor(ens, index) {
		ens.strategy = ens.strategy || 'moa';
		const flowBox = h('div', { class: 'flow', role: 'img' });
		const facts = h('div', { class: 'flow-facts' });
		const issuesBox = h('ul', { class: 'warnings' });

		// Live refresh of the parts that depend on the fields, without stealing input focus
		const update = () => {
			drawFlow(flowBox, ens);
			renderFacts(facts, ens);
			const perfBox = /** @type {HTMLElement|null} */ (editor?.querySelector('#perf-box'));
			if (perfBox) { renderPerf(perfBox, ens); }
			fill(issuesBox, ...ensembleIssues(ens, index).map(i => h('li', { class: i.err ? 'err' : '', text: i.text })));
			refreshFooter();
			const item = app.querySelectorAll('.ens-item')[index];
			const strong = item?.querySelector('strong');
			if (strong) { strong.textContent = ens.name || 'Unnamed ensemble'; }
		};

		const text = (/** @type {string} */ id, /** @type {string} */ prop, /** @type {Record<string, any>} */ extra = {}) => h('input', {
			type: 'text', id, value: ens[prop] ?? '', spellcheck: 'false', ...extra,
			oninput: (/** @type {any} */ e) => { ens[prop] = e.target.value; update(); },
			// model fields: re-render on commit so reasoning options follow the model
			onchange: extra.list ? () => render() : undefined,
		});
		const check = (/** @type {string} */ prop, /** @type {string} */ title, /** @type {string} */ sub, /** @type {boolean} */ enabled = true) => h('label', { class: `option${enabled ? '' : ' disabled'}` },
			h('input', { type: 'checkbox', checked: !!ens[prop], disabled: !enabled, onchange: (/** @type {any} */ e) => { ens[prop] = e.target.checked; update(); } }),
			h('strong', { text: title }),
			h('span', { class: 'sub', text: sub }),
		);

		// --- drafting model rows
		const addInput = /** @type {HTMLInputElement} */ (h('input', {
			type: 'text', id: 'ens-add', list: 'model-options', class: 'mono', placeholder: 'Model ID, e.g. ~google/gemini-flash-latest', spellcheck: 'false',
			onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') { e.preventDefault(); addProposer(); } },
		}));
		const addProposer = () => {
			const id = addInput.value.trim();
			if (!id) { return; }
			ens.proposers.push({ model: id });
			render();
			/** @type {HTMLInputElement|null} */ (app.querySelector('#ens-add'))?.focus();
		};
		const counts = new Map();
		ens.proposers.forEach((/** @type {any} */ p) => counts.set(p.model, (counts.get(p.model) || 0) + 1));

		const proposerRows = ens.proposers.map((/** @type {any} */ p, /** @type {number} */ i) => h('div', { class: `row-item${knownModel(p.model) ? '' : ' warn'}` },
			h('div', { class: 'row-main' },
				h('code', { class: 'id strong', text: p.model }),
				h('input', {
					type: 'text', class: 'role', value: p.role || '', placeholder: 'Perspective (optional), e.g. focus on security',
					'aria-label': `Perspective for ${p.model}`,
					oninput: (/** @type {any} */ e) => { p.role = e.target.value; update(); },
				}),
			),
			h('input', {
				type: 'number', class: 'temp', min: 0, max: 2, step: 0.1, value: p.temperature ?? '',
				placeholder: counts.get(p.model) > 1 ? 'auto' : 'default', title: counts.get(p.model) > 1 ? 'Unset: automatic spread (0.3 / 0.7 / 1.0 …) because this model appears more than once' : 'Temperature',
				'aria-label': `Temperature for ${p.model}`,
				oninput: (/** @type {any} */ e) => { p.temperature = e.target.value === '' ? undefined : Number(e.target.value); update(); },
			}),
			effortSelect(p.model, p.reasoning, v => { p.reasoning = v || undefined; update(); }, ens.proposerReasoning ? `ensemble (${ens.proposerReasoning})` : 'default'),
			h('button', { class: 'icon-btn', 'aria-label': `Remove ${p.model}`, title: 'Remove', onclick: () => { ens.proposers.splice(i, 1); render(); } }, '\u00d7'),
		));

		const strategyOption = (/** @type {string} */ value) => h('label', { class: 'option' },
			h('input', { type: 'radio', name: 'strategy', value, checked: ens.strategy === value, onchange: () => { ens.strategy = value; render(); } }),
			h('strong', { text: STRATEGIES[value].title }),
			h('span', { class: 'sub', text: STRATEGIES[value].sub }),
		);

		const usesJudge = ens.strategy === 'judge' || ens.strategy === 'council' || (ens.critique && (ens.strategy === 'moa' || ens.strategy === 'plan'));
		const quorumDefault = Math.max(1, Math.ceil(ens.proposers.length / 2));

		/** @type {HTMLElement} */
		let editor;
		editor = h('div', { class: 'editor' },
			h('h2', { text: ens.name || 'Unnamed ensemble' }),
			flowBox,
			facts,
			issuesBox,

			h('div', { class: 'field' },
				h('label', { for: 'ens-name', text: 'Name in the model picker' }),
				text('ens-name', 'name'),
			),
			h('div', { class: 'field' },
				h('span', { class: 'label', text: 'How the models work together' }),
				h('div', { class: 'options', role: 'radiogroup' }, Object.keys(STRATEGIES).map(strategyOption)),
			),

			h('div', { class: 'field' },
				h('label', { for: 'ens-add', text: `Drafting models (${ens.proposers.length})` }),
				proposerRows.length ? h('div', { class: 'rows' }, proposerRows) : null,
				h('div', { class: 'row' }, addInput, h('button', { class: 'btn secondary', onclick: addProposer }, 'Add model')),
				h('p', { class: 'help', text: 'Mix different model families for varied ideas, or add the same strong model several times (Self-MoA); repeated models get spread-out temperatures automatically. A perspective steers one model toward a concern, like security or tests.' }),
			),
			h('div', { class: 'perf-box', id: 'perf-box' }),
			h('div', { class: 'field' },
				h('label', { for: 'ens-preason', text: 'Reasoning for drafting models' }),
				h('div', { class: 'row' }, effortSelect('', ens.proposerReasoning, v => { ens.proposerReasoning = v || undefined; render(); }, 'model default', 'ens-preason')),
				h('p', { class: 'help', text: 'Used for drafts and reviews unless a row sets its own. Lower effort keeps drafts fast; spend it on the final model instead.' }),
			),

			h('div', { class: 'field' },
				h('label', { for: 'ens-agg', text: 'Final model' }),
				h('div', { class: 'row' },
					text('ens-agg', 'aggregator', { list: 'model-options', class: 'mono' }),
					effortSelect(ens.aggregator, ens.aggregatorReasoning, v => { ens.aggregatorReasoning = v || undefined; update(); }, 'default reasoning'),
				),
				h('p', { class: 'help', text: 'Writes the answer you see and runs tools. Its quality matters most, so pick your strongest tool-calling model here.' }),
			),

			h('div', { class: 'field' },
				h('span', { class: 'label', text: 'Extra steps' }),
				h('div', { class: 'options' },
					check('refine', 'Revise drafts', 'Second layer: each drafting model sees the others\u2019 drafts and improves its own. Doubles the drafting calls.'),
					check('critique', 'Critique before answering', 'The judge model lists strengths and errors of every draft for the final model. One extra call.', ens.strategy === 'moa' || ens.strategy === 'plan'),
					check('reread', 'Re-read the request', 'Repeats the latest request at the end of the drafting prompt (RE2). Free; small gains on long contexts.'),
				),
			),
			usesJudge ? h('div', { class: 'field' },
				h('label', { for: 'ens-judge', text: 'Judge model' }),
				text('ens-judge', 'judge', { list: 'model-options', class: 'mono', placeholder: `Same as final model (${ens.aggregator || 'not set'})` }),
				h('p', { class: 'help', text: ens.strategy === 'council' ? 'Only used when all drafts come from one model, so peers can\u2019t review each other.' : 'Scores or critiques the drafts. A different model family than the drafting models avoids self-preference.' }),
			) : null,

			h('div', { class: 'field' },
				h('span', { class: 'label', text: 'Speed' }),
				h('div', { class: 'row inline-fields' },
					h('label', { class: 'inline' }, 'Start after', h('input', {
						type: 'number', min: 1, max: Math.max(1, ens.proposers.length), step: 1, value: ens.quorum ?? '', placeholder: String(quorumDefault),
						oninput: (/** @type {any} */ e) => { ens.quorum = e.target.value === '' ? undefined : Number(e.target.value); update(); },
					}), 'drafts, then wait at most'),
					h('label', { class: 'inline' }, h('input', {
						type: 'number', min: 0, step: 1, value: ens.graceSeconds ?? 10,
						oninput: (/** @type {any} */ e) => { ens.graceSeconds = Number(e.target.value) || 0; update(); },
					}), 'seconds for the rest'),
				),
				h('p', { class: 'help', text: 'One slow model never holds up the answer: once enough drafts are in, the others get a short grace period and are then cancelled.' }),
			),
			h('div', { class: 'field' },
				h('label', { for: 'ens-trigger', text: 'When to draft' }),
				h('select', { id: 'ens-trigger', onchange: (/** @type {any} */ e) => { ens.trigger = e.target.value; render(); } },
					h('option', { value: 'afterExploration', selected: ens.trigger === 'afterExploration' ? true : null }, 'After the agent has read the code (best in agent mode)'),
					h('option', { value: 'userTurns', selected: (ens.trigger || 'userTurns') === 'userTurns' ? true : null }, 'Right away, once per message you send'),
					h('option', { value: 'always', selected: ens.trigger === 'always' ? true : null }, 'On every step, including each tool call'),
				),
				h('p', { class: 'help', text: ens.trigger === 'afterExploration'
					? 'The final model first looks around with read-only tools: memory, the files involved, search. When it has enough context it asks for the drafts, so the drafting models see that code too. Editing is blocked until then. Simple questions are answered directly without drafts; without tools (ask mode) drafting starts right away.'
					: 'Drafts start immediately and only see the conversation and attachments, not files the agent reads later. Tool steps of the same message reuse the drafts.' }),
			),
			ens.trigger === 'afterExploration' ? h('div', { class: 'field row inline-fields' },
				h('label', { class: 'inline', for: 'ens-explore' }, 'Start drafting after at most', h('input', {
					type: 'number', id: 'ens-explore', min: 1, max: 20, step: 1, value: ens.maxExplorationSteps ?? 4,
					oninput: (/** @type {any} */ e) => { ens.maxExplorationSteps = Number(e.target.value) || 4; update(); },
				}), 'rounds of reading'),
			) : null,
			h('div', { class: 'field row inline-fields' },
				h('label', { class: 'inline', for: 'ens-max' }, 'Maximum draft length', h('input', {
					type: 'number', id: 'ens-max', min: 256, step: 256, value: ens.proposerMaxTokens ?? 4096,
					oninput: (/** @type {any} */ e) => { ens.proposerMaxTokens = Number(e.target.value) || 4096; update(); },
				}), 'tokens'),
				h('label', { class: 'inline', for: 'ens-id' }, 'ID', text('ens-id', 'id', { class: 'mono short' })),
			),
			h('div', { class: 'field' },
				h('button', {
					class: 'btn danger',
					onclick: () => {
						if (!confirmDelete) { confirmDelete = true; render(); return; }
						state.ensembles.splice(index, 1);
						confirmDelete = false;
						selected = Math.max(0, index - 1);
						persist();
						render();
					},
				}, confirmDelete ? 'Click again to delete' : 'Delete ensemble'),
			),
			modelDatalist(),
		);

		update();
		return editor;
	}

	const VERDICT = {
		collecting: 'collecting data',
		strong: 'strong',
		fair: 'fair',
		weak: 'weak',
		slow: 'slow',
		unreliable: 'unreliable',
	};

	/** How each drafting model of this ensemble has performed, from the local performance memory. @param {HTMLElement} box @param {any} ens */
	function renderPerf(box, ens) {
		const rows = (perf.byEnsemble[ens.id] || []).filter(s => ens.proposers.some((/** @type {any} */ p) => p.model === s.model));
		const header = h('div', { class: 'perf-head' },
			h('h3', { text: 'How the drafting models perform' }),
			rows.length ? h('button', { class: 'link', onclick: () => post({ type: 'resetPerf', ensembleId: ens.id }) }, 'Reset for this ensemble') : null,
		);
		if (state.general.performanceMemory === false) {
			fill(box, header, h('p', { class: 'help', text: 'Performance memory is off (Advanced).' }));
			return;
		}
		if (!rows.length) {
			fill(box, header, h('p', { class: 'help', text: 'No data yet. After you use this ensemble, you\u2019ll see here how often each model\u2019s draft wins reviews and how much of the final answer comes from it.' }));
			return;
		}
		const pctOf = (/** @type {number|undefined} */ x) => x === undefined ? '\u2013' : `${Math.round(x * 100)}%`;
		const secs = (/** @type {number|undefined} */ ms) => ms === undefined ? '\u2013' : `${(ms / 1000).toFixed(1)} s`;
		const usd = (/** @type {number|undefined} */ c) => c === undefined ? '\u2013' : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(3)}`;

		const table = h('table', { class: 'perf' },
			h('thead', {}, h('tr', {},
				h('th', { text: 'Model' }),
				h('th', { class: 'num', text: 'Msgs', title: 'Messages this model drafted for' }),
				h('th', { class: 'num', text: 'Wins', title: 'Ranked best by reviewers (council / judge)' }),
				h('th', { class: 'num', text: 'Used', title: 'Average share of the final answer that came from this model\u2019s draft' }),
				h('th', { class: 'num', text: 'Share', title: 'Contribution relative to a fair share: 1.0\u00d7 = exactly its share, 2.0\u00d7 = twice that' }),
				h('th', { class: 'num', text: 'Time' }),
				h('th', { class: 'num', text: 'Cost/msg' }),
				h('th', { text: 'Verdict' }),
			)),
			h('tbody', {}, rows.map(s => h('tr', {},
				h('td', {}, h('code', { title: s.model, text: truncate(s.model.replace(/^~/, ''), 26) })),
				h('td', { class: 'num', text: String(s.turns) }),
				h('td', { class: 'num', title: s.reviewedTurns ? `${s.reviewedTurns} reviewed messages` : '', text: s.reviewedTurns ? pctOf(s.winRate) : '\u2013' }),
				h('td', { class: 'num', text: s.adoptionTurns ? pctOf(s.avgAdoption) : '\u2013' }),
				h('td', { class: 'num', text: s.relativeQuality === undefined ? '\u2013' : `${s.relativeQuality.toFixed(1)}\u00d7` }),
				h('td', { class: 'num', text: secs(s.avgMs) }),
				h('td', { class: 'num', text: usd(s.avgCost) }),
				h('td', {}, h('span', { class: `verdict ${s.verdict}`, title: s.reason || '', text: VERDICT[s.verdict] || s.verdict })),
			))),
		);

		const actionable = rows.filter(s => ['weak', 'slow', 'unreliable'].includes(s.verdict));
		const advice = actionable.map(s => h('li', {},
			h('span', { text: `${shortId(s.model)} ${s.reason}. ` }),
			h('button', {
				class: 'link',
				onclick: () => { ens.proposers = ens.proposers.filter((/** @type {any} */ p) => p.model !== s.model); render(); },
			}, 'Remove from ensemble'),
		));
		const least = Math.min(...rows.map(s => s.turns));
		const note = least < 10
			? `Verdicts appear after 10 messages per model (fewest so far: ${least}).`
			: least < 30 ? 'Preliminary: based on fewer than 30 messages per model.' : '';

		fill(box, header,
			h('div', { class: 'table-scroll' }, table),
			advice.length ? h('ul', { class: 'advice' }, advice) : null,
			note ? h('p', { class: 'help', text: note }) : null,
			h('p', { class: 'help', text: 'Recorded locally: review results, how much of each final answer matches each draft, latency and cost. No prompts, drafts or code are stored.' }),
		);
	}

	/** @param {HTMLElement} box @param {any} ens */
	function renderFacts(box, ens) {
		const n = ens.proposers.length;
		const calls = callsPerMessage(ens);
		const quorum = Math.min(n, Math.max(1, Number(ens.quorum) || Math.ceil(n / 2)));

		const judgeModel = ens.judge || ens.aggregator;
		const usesJudge = ens.strategy === 'judge' || (ens.critique && (ens.strategy === 'moa' || ens.strategy === 'plan'));
		const members = [...ens.proposers.map((/** @type {any} */ p) => p.model), ens.aggregator, ...(usesJudge ? [judgeModel] : [])].map(id => byId.get(id));
		const known = members.filter(Boolean);
		let price = 'Prices appear once the model list has loaded.';
		if (known.length) {
			const sum = (/** @type {'priceIn'|'priceOut'} */ k) => known.reduce((acc, m) => acc + (m[k] ?? 0), 0);
			price = `All models combined: ${fmtPrice(sum('priceIn'))} input / ${fmtPrice(sum('priceOut'))} output per 1M tokens`;
			if (known.length < members.length) { price += ' (unknown models not counted)'; }
		}
		fill(box, 
			h('span', { text: `${calls} calls per message` }),
			n > 1 ? h('span', { text: `continues after ${quorum} of ${n} drafts + ${ens.graceSeconds ?? 10} s` }) : null,
			ens.trigger === 'afterExploration' ? h('span', { text: `drafts after reading (max ${ens.maxExplorationSteps ?? 4} rounds)` }) : null,
			h('span', { text: price }),
		);
	}

	/** Draws the drafting models, an optional middle stage, and the final model. @param {HTMLElement} box @param {any} ens */
	function drawFlow(box, ens) {
		const proposers = ens.proposers.length ? ens.proposers.map((/** @type {any} */ p) => p.model) : ['(add drafting models)'];
		const n = ens.proposers.length;
		/** @type {string[]} */
		const stages = [];
		if (ens.refine && n >= 2) { stages.push('revise'); }
		if (ens.strategy === 'council' && n >= 2) { stages.push(new Set(ens.proposers.map((/** @type {any} */ p) => p.model)).size > 1 ? 'peer review' : 'judge'); }
		if (ens.strategy === 'judge' && n >= 2) { stages.push('judge'); }
		if (ens.critique && (ens.strategy === 'moa' || ens.strategy === 'plan')) { stages.push('critique'); }

		const W = 700, NODE_W = 240, FINAL_W = 230, NODE_H = 28, GAP = 10, PAD = 6;
		const colH = proposers.length * NODE_H + (proposers.length - 1) * GAP;
		const H = Math.max(colH, NODE_H) + PAD * 2 + 22;
		const midY = PAD + colH / 2;
		const finalX = W - FINAL_W;
		const hasStage = stages.length > 0;
		const STAGE_W = 104, stageX = NODE_W + (finalX - NODE_W - STAGE_W) / 2;
		const joinX = hasStage ? stageX : finalX;

		const svg = s('svg', { viewBox: `-8 0 ${W + 16} ${H}`, 'aria-hidden': 'true' });

		proposers.forEach((/** @type {string} */ _id, /** @type {number} */ i) => {
			const y = PAD + i * (NODE_H + GAP) + NODE_H / 2;
			const cx = (NODE_W + joinX) / 2;
			svg.append(s('path', { class: 'edge', d: `M ${NODE_W} ${y} C ${cx} ${y}, ${cx} ${midY}, ${joinX} ${midY}` }));
		});
		if (hasStage) {
			svg.append(s('path', { class: 'edge', d: `M ${stageX + STAGE_W} ${midY} L ${finalX} ${midY}` }));
			const g = s('g', { class: 'node stage' });
			const stageH = 22 + (stages.length - 1) * 14;
			g.append(s('rect', { x: stageX, y: midY - stageH / 2, width: STAGE_W, height: stageH, rx: stageH / 2 }));
			stages.forEach((st, k) => {
				const t = s('text', { x: stageX + STAGE_W / 2, y: midY - stageH / 2 + 15 + k * 14, 'text-anchor': 'middle' });
				t.textContent = st;
				g.append(t);
			});
			svg.append(g);
		}

		proposers.forEach((/** @type {string} */ id, /** @type {number} */ i) => {
			const y = PAD + i * (NODE_H + GAP);
			const p = ens.proposers[i];
			const g = s('g', { class: `node${n && !knownModel(id) ? ' warn' : ''}` });
			g.append(s('rect', { x: 0, y, width: NODE_W, height: NODE_H, rx: 4 }));
			const t = s('text', { x: 10, y: y + NODE_H / 2 + 4 });
			const tag = p?.role ? ' \u2022' : '';
			t.textContent = truncate(id.replace(/^~/, ''), 30) + tag;
			g.append(t);
			svg.append(g);
		});

		const fg = s('g', { class: `node final${ens.aggregator && !knownModel(ens.aggregator) ? ' warn' : ''}` });
		fg.append(s('rect', { x: finalX, y: midY - NODE_H / 2 - 4, width: FINAL_W, height: NODE_H + 8, rx: 4 }));
		const ft = s('text', { x: finalX + 12, y: midY + 4 });
		ft.textContent = truncate((ens.aggregator || '(choose a final model)').replace(/^~/, ''), 29);
		fg.append(ft);
		svg.append(fg);

		const capL = s('text', { class: 'caption', x: 0, y: H - 4 });
		capL.textContent = ens.strategy === 'plan' ? 'Plan in parallel' : 'Draft in parallel';
		const capR = s('text', { class: 'caption', x: finalX, y: H - 4 });
		capR.textContent = ens.strategy === 'plan' ? 'Merges the plans and builds with tools' : 'Writes the answer and runs tools';
		svg.append(capL, capR);

		box.setAttribute('aria-label', `${n} drafting models${hasStage ? `, then ${stages.join(' and ')}` : ''}, feeding ${ens.aggregator || 'no final model yet'}`);
		fill(box, svg);
	}

	const truncate = (/** @type {string} */ t, /** @type {number} */ n) => t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;

	// --- Routers ---------------------------------------------------------------------------------

	function viewRouters() {
		const list = state.routers;
		if (selectedRouter >= list.length) { selectedRouter = Math.max(0, list.length - 1); }

		const addRouter = () => {
			let n = list.length + 1;
			while (allIds().includes(`auto-${n}`)) { n++; }
			const complex = state.ensembles[0] ? `ensemble:${state.ensembles[0].id}` : '~anthropic/claude-opus-latest';
			list.push({ id: `auto-${n}`, name: `Auto ${n}`, ...clone(DEFAULT_ROUTER), complex });
			selectedRouter = list.length - 1;
			confirmDeleteRouter = false;
			persist();
			render();
			/** @type {HTMLInputElement|null} */ (app.querySelector('#rt-name'))?.select();
		};

		const section = h('section', {},
			h('h1', { text: 'Routers' }),
			h('p', { class: 'lede', text: 'A router appears as one model, usually called Auto. It rates each message you send and picks a cheap model, a strong model, or an ensemble. Everyday questions stay cheap; hard tasks get the full ensemble.' }),
		);

		if (!list.length) {
			section.append(h('div', { class: 'status' },
				h('span', { class: 'dot' }),
				h('strong', { text: 'No routers yet' }),
				h('div', { class: 'facts' }, h('span', { text: 'Add one to send each message to the right model automatically.' })),
			), h('button', { class: 'btn', onclick: addRouter }, 'Add router'));
			return section;
		}

		section.append(
			h('div', { class: 'ens-list' }, list.map((/** @type {any} */ r, /** @type {number} */ i) => {
				const errs = routerIssues(r, i).filter(x => x.err).length;
				return h('button', {
					class: 'ens-item', 'aria-pressed': String(i === selectedRouter),
					onclick: () => { selectedRouter = i; confirmDeleteRouter = false; persist(); render(); },
				},
					h('strong', { text: r.name || 'Unnamed router' }),
					errs ? h('span', { class: 'issue', text: `${errs} issue${errs > 1 ? 's' : ''}` }) : null,
					h('span', { class: 'sub', text: [r.simple, r.standard, r.complex].map(targetLabel).join(' \u2192 ') }),
				);
			})),
			h('button', { class: 'btn secondary', onclick: addRouter }, 'Add router'),
			renderRouterEditor(list[selectedRouter], selectedRouter),
		);
		return section;
	}

	/** @param {string} target */
	function targetLabel(target) {
		if (!target) { return '(not set)'; }
		if (target.startsWith('ensemble:')) {
			return state.ensembles.find((/** @type {any} */ e) => `ensemble:${e.id}` === target)?.name || target;
		}
		return shortId(target);
	}

	/** @param {any} r @param {number} index */
	function renderRouterEditor(r, index) {
		const issuesBox = h('ul', { class: 'warnings' });
		const tiersBox = h('div', { class: 'tiers' });
		const update = () => {
			fill(issuesBox, ...routerIssues(r, index).map(i => h('li', { class: i.err ? 'err' : '', text: i.text })));
			drawTiers(tiersBox, r);
			refreshFooter();
			const strong = app.querySelectorAll('.ens-item')[index]?.querySelector('strong');
			if (strong) { strong.textContent = r.name || 'Unnamed router'; }
		};
		const text = (/** @type {string} */ id, /** @type {string} */ prop, /** @type {Record<string, any>} */ extra = {}) => h('input', {
			type: 'text', id, value: r[prop] ?? '', spellcheck: 'false', ...extra,
			oninput: (/** @type {any} */ e) => { r[prop] = e.target.value; update(); },
		});

		const tier = (/** @type {string} */ key, /** @type {string} */ title, /** @type {string} */ sub) => h('div', { class: 'field' },
			h('label', { for: `rt-${key}`, text: title }),
			text(`rt-${key}`, key, { list: 'target-options', class: 'mono', placeholder: 'Model ID or ensemble' }),
			h('p', { class: 'help', text: sub }),
		);

		const editor = h('div', { class: 'editor' },
			h('h2', { text: r.name || 'Unnamed router' }),
			tiersBox,
			issuesBox,
			h('div', { class: 'field' },
				h('label', { for: 'rt-name', text: 'Name in the model picker' }),
				text('rt-name', 'name'),
			),
			tier('simple', 'Simple requests', 'Greetings, quick questions, small snippets. A fast, cheap model.'),
			tier('standard', 'Standard requests', 'Typical feature work, bug fixes and reviews. Your everyday strong model.'),
			tier('complex', 'Complex requests', 'Multi-file changes, subtle bugs, design questions. An ensemble pays off here; Plan & build fits agent mode best.'),
			h('div', { class: 'field' },
				h('label', { class: 'check' },
					h('input', { type: 'checkbox', checked: r.useClassifier !== false, onchange: (/** @type {any} */ e) => { r.useClassifier = e.target.checked; render(); } }),
					'Ask a small model when the heuristics are unsure'),
				h('p', { class: 'help', text: 'Obvious cases are decided for free by length, code and keywords. For the rest, a cheap model rates the difficulty from 1 to 5, and its score is blended with the heuristics.' }),
			),
			r.useClassifier !== false ? h('div', { class: 'field' },
				h('label', { for: 'rt-classifier', text: 'Rating model' }),
				text('rt-classifier', 'classifier', { list: 'model-options', class: 'mono' }),
				h('p', { class: 'help', text: 'Sees only the typed request, never your attachments. Pick the cheapest fast model you trust.' }),
			) : null,
			h('p', { class: 'help', text: 'If a target can\u2019t call tools or read images and the request needs that, the router moves up one level. All tool steps of one message stay on the chosen target.' }),
			h('div', { class: 'field row inline-fields' },
				h('label', { class: 'inline', for: 'rt-id' }, 'ID', text('rt-id', 'id', { class: 'mono short' })),
			),
			h('div', { class: 'field' },
				h('button', {
					class: 'btn danger',
					onclick: () => {
						if (!confirmDeleteRouter) { confirmDeleteRouter = true; render(); return; }
						state.routers.splice(index, 1);
						confirmDeleteRouter = false;
						selectedRouter = Math.max(0, index - 1);
						persist();
						render();
					},
				}, confirmDeleteRouter ? 'Click again to delete' : 'Delete router'),
			),
			modelDatalist(true),
			modelDatalist(),
		);
		update();
		return editor;
	}

	/** Three-way split: message → rating → simple / standard / complex. @param {HTMLElement} box @param {any} r */
	function drawTiers(box, r) {
		const W = 700, H = 132, NODE_H = 28, TW = 250, tx = W - TW;
		const rows = [['simple', 1], ['standard', 2], ['complex', 3]].map(([k], i) => ({ k, y: 10 + i * 40 }));
		const svg = s('svg', { viewBox: `-8 0 ${W + 16} ${H}`, 'aria-hidden': 'true' });
		const srcY = 10 + 40 + NODE_H / 2;
		const src = s('g', { class: 'node stage' });
		src.append(s('rect', { x: 0, y: srcY - 16, width: 150, height: 32, rx: 16 }));
		const st = s('text', { x: 75, y: srcY + 4, 'text-anchor': 'middle' });
		st.textContent = r.useClassifier !== false ? 'rate difficulty' : 'heuristics';
		src.append(st);
		for (const row of rows) {
			const y = row.y + NODE_H / 2;
			const cx = (150 + tx) / 2;
			svg.append(s('path', { class: 'edge', d: `M 150 ${srcY} C ${cx} ${srcY}, ${cx} ${y}, ${tx} ${y}` }));
		}
		svg.append(src);
		for (const row of rows) {
			const target = r[row.k] || '';
			const isEns = target.startsWith('ensemble:');
			const g = s('g', { class: `node${isEns ? ' final' : ''}` });
			g.append(s('rect', { x: tx, y: row.y, width: TW, height: NODE_H, rx: 4 }));
			const t = s('text', { x: tx + 10, y: row.y + NODE_H / 2 + 4 });
			t.textContent = truncate(`${row.k}: ${targetLabel(target)}`, 32);
			g.append(t);
			svg.append(g);
		}
		const cap = s('text', { class: 'caption', x: 0, y: H - 4 });
		cap.textContent = 'Per message; tool steps stay on the same target';
		svg.append(cap);
		box.className = 'flow';
		box.setAttribute('role', 'img');
		box.setAttribute('aria-label', `Routes to ${targetLabel(r.simple)}, ${targetLabel(r.standard)} or ${targetLabel(r.complex)}`);
		fill(box, svg);
	}

	// --- Advanced --------------------------------------------------------------------------------

	function viewAdvanced() {
		const g = state.general;
		const jsonError = h('p', { class: 'error-text', role: 'alert' });
		const area = /** @type {HTMLTextAreaElement} */ (h('textarea', {
			id: 'extra-body', spellcheck: 'false', value: extraBodyText,
			oninput: (/** @type {any} */ e) => { extraBodyText = e.target.value; checkJson(); refreshFooter(); },
		}));
		const checkJson = () => {
			const err = extraBodyError();
			jsonError.textContent = err || '';
			area.classList.toggle('invalid', !!err);
		};
		checkJson();

		const num = (/** @type {string} */ id, /** @type {string} */ prop, /** @type {number} */ min, /** @type {number} */ step) => h('input', {
			type: 'number', id, min, step, value: g[prop],
			oninput: (/** @type {any} */ e) => { g[prop] = Number(e.target.value); refreshFooter(); },
		});

		return h('section', {},
			h('h1', { text: 'Advanced' }),
			h('p', { class: 'lede', text: 'Limits and request options that apply to every ensemble.' }),
			h('div', { class: 'field' },
				h('label', { for: 'timeout', text: 'Draft timeout (seconds)' }),
				num('timeout', 'proposerTimeoutSeconds', 5, 5),
				h('p', { class: 'help', text: 'Drafting models that take longer are skipped. The final model still answers with the drafts that arrived.' }),
			),
			h('div', { class: 'field' },
				h('label', { for: 'context', text: 'Conversation sent to drafting models (characters)' }),
				num('context', 'proposerContextChars', 1000, 10000),
				h('p', { class: 'help', text: 'Drafting models get the conversation as plain text. When it\u2019s longer than this, the oldest part is cut. The final model always gets the full conversation.' }),
			),
			h('div', { class: 'field' },
				h('label', { class: 'check' },
					h('input', { type: 'checkbox', checked: g.logUsage, onchange: (/** @type {any} */ e) => { g.logUsage = e.target.checked; refreshFooter(); } }),
					'Log tokens and cost of every call',
				),
				h('p', { class: 'help' }, 'Useful to see what an ensemble really costs. ',
					h('button', { class: 'link', onclick: () => post({ type: 'openLog' }) }, 'Open the log'), '.'),
			),
			h('div', { class: 'field' },
				h('label', { class: 'check' },
					h('input', { type: 'checkbox', checked: g.stickySessions !== false, onchange: (/** @type {any} */ e) => { g.stickySessions = e.target.checked; refreshFooter(); } }),
					'Keep each conversation on the same provider',
				),
				h('p', { class: 'help', text: 'Sends a session ID per conversation so OpenRouter routes all its requests to the same provider. In agent mode most of the prompt repeats on every tool step, so prompt caching cuts the cost of those steps considerably. The log shows cached tokens.' }),
			),
			h('div', { class: 'field' },
				h('label', { class: 'check' },
					h('input', { type: 'checkbox', checked: g.performanceMemory !== false, onchange: (/** @type {any} */ e) => { g.performanceMemory = e.target.checked; refreshFooter(); } }),
					'Remember how each drafting model performs',
				),
				h('p', { class: 'help' },
					`Shows per ensemble which models win reviews, how much of the final answer comes from their drafts, and what they cost, and suggests removing weak ones. Stored locally as numbers only. ${perf.total} message${perf.total === 1 ? '' : 's'} recorded. `,
					perf.total ? h('button', { class: 'link', onclick: () => post({ type: 'resetPerf' }) }, 'Forget all') : null,
				),
			),
			h('div', { class: 'field' },
				h('label', { for: 'extra-body', text: 'Extra request fields (JSON)' }),
				area,
				jsonError,
				h('p', { class: 'help' }, 'Merged into every request to OpenRouter. For example, ',
					h('code', { text: '{"provider": {"data_collection": "deny"}}' }),
					' only routes to providers that don\u2019t store your prompts.'),
			),
		);
	}

	// ---------------------------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------------------------

	function save() {
		if (!isDirty() || allErrors().length) { return; }
		saving = true;
		flash = null;
		post({ type: 'save', state: currentPayload() });
		refreshFooter();
	}

	function discard() {
		const saved = JSON.parse(savedJson);
		loadState(saved);
		externalChange = false;
		confirmDelete = false;
		render();
	}

	/** @param {any} next */
	function loadState(next) {
		state = clone(next);
		state.routers = state.routers || [];
		state.modelReasoning = state.modelReasoning || {};
		state.fallbacks = state.fallbacks || {};
		state.ensembles = (state.ensembles || []).map((/** @type {any} */ e) => ({
			...e,
			strategy: e.strategy || 'moa',
			proposers: (e.proposers || []).map((/** @type {any} */ p) => typeof p === 'string' ? { model: p } : { ...p }),
		}));
		extraBodyText = JSON.stringify(state.general.extraBody ?? {}, null, 2);
		savedJson = JSON.stringify(currentPayload());
	}

	/** @param {string} text @param {boolean} [err] */
	function showFlash(text, err) {
		flash = { text, err };
		refreshFooter();
		setTimeout(() => { if (flash?.text === text) { flash = null; refreshFooter(); } }, 3000);
	}

	window.addEventListener('keydown', e => {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			e.preventDefault();
			save();
		}
	});

	window.addEventListener('message', event => {
		const msg = event.data;
		switch (msg.type) {
			case 'config':
				overrides = msg.overrides || [];
				// Our own save triggers a config event before the 'saved' reply; ignore it
				if (saving) { break; }
				if (!state || !isDirty()) {
					loadState(msg.state);
				} else {
					externalChange = true;
				}
				render();
				break;
			case 'saved':
				saving = false;
				externalChange = false;
				loadState(msg.state);
				render();
				showFlash('Saved. The model picker updates in a moment.');
				break;
			case 'key': {
				const wasChecking = key.checking;
				key = { loaded: true, has: msg.has, info: msg.info || null, error: msg.keyError || null, checking: false, saveError: null };
				render();
				if (wasChecking && msg.has && msg.info) { showFlash('API key saved and verified.'); }
				break;
			}
			case 'perf': {
				perf = { total: msg.total || 0, byEnsemble: msg.byEnsemble || {} };
				// Update in place so inputs keep focus
				const box = /** @type {HTMLElement|null} */ (app.querySelector('#perf-box'));
				if (box && tab === 'ensembles' && state) { renderPerf(box, state.ensembles[selected]); } else if (tab === 'advanced' && state && !isDirty()) { render(); }
				break;
			}
			case 'mgmt':
				mgmt = { has: !!msg.has, checking: false, error: msg.error || null, balance: msg.balance ?? null };
				if (tab === 'connection') { render(); }
				break;
			case 'keySaveFailed':
				key.checking = false;
				key.saveError = msg.message;
				render();
				break;
			case 'catalog':
				catalog = msg.catalog || [];
				byId = new Map(catalog.map(m => [m.id, m]));
				catalogError = msg.catalogError || null;
				catalogLoading = false;
				if (state) { render(); }
				break;
			case 'error':
				saving = false;
				key.checking = false;
				render();
				showFlash(msg.message, true);
				break;
		}
	});

	render();
	post({ type: 'ready' });
})();
