import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Managed graphify install: no Python, uv or terminal needed on the machine.
 *
 * 1. Downloads uv as a wheel from PyPI (pinned version, pinned SHA-256 per platform) and extracts the binary.
 * 2. `uv tool install "graphifyy[mcp]"` into the extension's global storage. uv uses a system Python ≥ 3.10
 *    if there is one, otherwise it downloads its own into the same folder.
 *
 * Everything lives under one folder (tools, launchers, Python, cache); nothing is written to the user's
 * PATH, home directory or shell profile. Removing the folder removes the install.
 */

export const UV_VERSION = '0.12.19';
export const GRAPHIFY_REQUIREMENT = 'graphifyy[mcp]>=0.9.71';

/** uv wheels on PyPI. Linux x64 uses the static musl build, which runs on glibc systems too. */
export const UV_WHEELS: Record<string, { url: string; sha256: string }> = {
	'darwin-x64': { url: 'https://files.pythonhosted.org/packages/3b/47/d5b795f5c58c20f21216ce3b57a9d214c3bb349cde1e53d5f6fa1a002683/uv-0.12.19-py3-none-macosx_10_12_x86_64.whl', sha256: '13e1f008a379b71f07a2f8caf62c0baac9d9039f4238e2e9192f7ddcfc0a1913' },
	'darwin-arm64': { url: 'https://files.pythonhosted.org/packages/fa/7a/d1909986764de5d7d2781e7f0c29a6434b7762e626bca9ee85b1d124541f/uv-0.12.19-py3-none-macosx_11_0_arm64.whl', sha256: '5da0401c0898b5fe767968f5a72f27525276b119d69e0c7c25b721f63ecef650' },
	'linux-arm64': { url: 'https://files.pythonhosted.org/packages/49/5c/4690490a19726b44d8fd01cdbdc56061fdebf99bb3e466215f276eefbd5d/uv-0.12.19-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl', sha256: 'b466eb0f74645883df52446d54474905e8515d75fdf0b313bf099dedc3237896' },
	'linux-x64': { url: 'https://files.pythonhosted.org/packages/28/cd/e57952eef1e24d52403a73c25c73d5697791eb72debe4a2facf9006fcba5/uv-0.12.19-py3-none-musllinux_1_1_x86_64.whl', sha256: 'a6512549e6bf12013190639bd5d9ef780f197d7adf4770a628c5e681577543d8' },
	'win32-x64': { url: 'https://files.pythonhosted.org/packages/c2/5d/8e0b84503b77ead843ef57e4f9305eb32a95cac6806c0e0d54b9404a5f7b/uv-0.12.19-py3-none-win_amd64.whl', sha256: 'dcbc531a96762569bbfe9639b4f45f00aabff51f427540711f63e7c23f225fdf' },
	'win32-arm64': { url: 'https://files.pythonhosted.org/packages/c6/5b/cfbe66622cd20dd56335bca1e7c8e83c1b893a1a79d69178ab771e313857/uv-0.12.19-py3-none-win_arm64.whl', sha256: '76b48a93e5c9e38cf3b41dcb02f9170935dcb9cd2f99aa0dd44caaa2d8dc2b9d' },
};

export function platformKey(platform: string = process.platform, arch: string = process.arch) {
	return `${platform}-${arch}`;
}

// -------------------------------------------------------------------------------------------------
// Minimal ZIP reader (wheels are ZIP files): enough to pull one entry out, no dependencies.
// -------------------------------------------------------------------------------------------------

export function readZipEntry(zip: Buffer, name: string): Buffer | undefined {
	const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
		if (zip.readUInt32LE(i) === EOCD) { eocd = i; break; }
	}
	if (eocd < 0) { throw new Error('not a zip file'); }
	const entries = zip.readUInt16LE(eocd + 10);
	let p = zip.readUInt32LE(eocd + 16);
	for (let n = 0; n < entries; n++) {
		if (zip.readUInt32LE(p) !== CEN) { throw new Error('corrupt zip central directory'); }
		const method = zip.readUInt16LE(p + 10);
		const compSize = zip.readUInt32LE(p + 20);
		const size = zip.readUInt32LE(p + 24);
		const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
		const local = zip.readUInt32LE(p + 42);
		const entryName = zip.toString('utf8', p + 46, p + 46 + nameLen);
		if (entryName === name) {
			if (zip.readUInt32LE(local) !== LOC) { throw new Error('corrupt zip local header'); }
			const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
			const data = zip.subarray(start, start + compSize);
			const out = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : undefined;
			if (!out) { throw new Error(`unsupported zip compression ${method}`); }
			if (out.length !== size) { throw new Error('zip entry size mismatch'); }
			return out;
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return undefined;
}

// -------------------------------------------------------------------------------------------------

export interface InstallProgress {
	report(message: string): void;
}

export interface ManagedOptions {
	/** Extra environment (proxy settings from VS Code). */
	env?: () => Record<string, string>;
	fetch?: typeof fetch;
	log?: (message: string) => void;
}

export class ManagedGraphify {
	readonly exe = process.platform === 'win32' ? '.exe' : '';

	constructor(readonly root: string, private readonly opts: ManagedOptions = {}) { }

	get uvPath() { return path.join(this.root, 'uv', `uv${this.exe}`); }
	get binDir() { return path.join(this.root, 'bin'); }
	get cliPath() { return path.join(this.binDir, `graphify${this.exe}`); }

	get supported() { return !!UV_WHEELS[platformKey()]; }

	async installed(): Promise<boolean> {
		return isFile(this.cliPath);
	}

	/** Environment that confines uv to the managed folder. */
	env(): NodeJS.ProcessEnv {
		const r = this.root;
		return {
			...process.env,
			...this.opts.env?.(),
			UV_TOOL_DIR: path.join(r, 'tools'),
			UV_TOOL_BIN_DIR: this.binDir,
			UV_PYTHON_INSTALL_DIR: path.join(r, 'python'),
			UV_PYTHON_BIN_DIR: path.join(r, 'python-bin'),
			UV_CACHE_DIR: path.join(r, 'cache'),
			// system certificate store: works behind TLS-inspecting corporate proxies
			UV_NATIVE_TLS: '1',
			UV_NO_PROGRESS: '1',
			PYTHONIOENCODING: 'utf-8',
		};
	}

	/** Downloads uv (if needed) and installs graphify. Idempotent; `upgrade` refreshes an existing install. */
	async install(progress: InstallProgress, signal?: AbortSignal, upgrade = false): Promise<string> {
		const wheel = UV_WHEELS[platformKey()];
		if (!wheel) { throw new Error(`No automatic install for ${platformKey()}. Install graphify manually: uv tool install "graphifyy[mcp]"`); }
		await fs.mkdir(this.root, { recursive: true });

		if (!await this.hasUv()) {
			progress.report(`Downloading uv ${UV_VERSION}…`);
			const data = await this.download(wheel.url, signal, progress);
			const digest = createHash('sha256').update(data).digest('hex');
			if (digest !== wheel.sha256) { throw new Error(`uv download failed verification (sha256 ${digest}, expected ${wheel.sha256})`); }
			const bin = readZipEntry(data, `uv-${UV_VERSION}.data/scripts/uv${this.exe}`);
			if (!bin) { throw new Error('uv binary not found in the wheel'); }
			await fs.mkdir(path.dirname(this.uvPath), { recursive: true });
			const tmp = `${this.uvPath}.${process.pid}.tmp`;
			await fs.writeFile(tmp, bin, { mode: 0o755 });
			await fs.rename(tmp, this.uvPath);
			this.opts.log?.(`graphify install: uv ${UV_VERSION} verified and extracted to ${this.uvPath}`);
		}

		progress.report(upgrade ? 'Updating graphify…' : 'Installing graphify (and Python, if none is available)…');
		const args = upgrade && await this.installed()
			? ['tool', 'upgrade', 'graphifyy']
			: ['tool', 'install', '--force', GRAPHIFY_REQUIREMENT];
		const out = await this.run(this.uvPath, args, signal);
		this.opts.log?.(`graphify install: uv ${args.join(' ')}\n${out.trim()}`);
		if (!await this.installed()) { throw new Error(`uv finished, but ${this.cliPath} is missing:\n${out.trim()}`); }
		return this.cliPath;
	}

	async remove() {
		await fs.rm(this.root, { recursive: true, force: true });
	}

	private async hasUv(): Promise<boolean> {
		if (!await isFile(this.uvPath)) { return false; }
		try {
			return (await this.run(this.uvPath, ['--version'])).includes(UV_VERSION);
		} catch {
			return false;
		}
	}

	private async download(url: string, signal: AbortSignal | undefined, progress: InstallProgress): Promise<Buffer> {
		const res = await (this.opts.fetch ?? fetch)(url, { signal });
		if (!res.ok || !res.body) { throw new Error(`Download failed: HTTP ${res.status} for ${url}`); }
		const total = Number(res.headers.get('content-length')) || 0;
		const chunks: Buffer[] = [];
		let received = 0, lastReport = 0;
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) { break; }
			chunks.push(Buffer.from(value));
			received += value.length;
			if (total && received - lastReport > 2 * 1024 * 1024) {
				lastReport = received;
				progress.report(`Downloading uv ${UV_VERSION}… ${Math.round(received / total * 100)}%`);
			}
		}
		return Buffer.concat(chunks);
	}

	private run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(cmd, args, { env: this.env(), signal, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
				(err, stdout, stderr) => err ? reject(new Error(String(stderr).trim() || err.message)) : resolve(`${stdout}\n${stderr}`));
		});
	}
}

/** VS Code's `http.proxy` for uv, unless the environment already sets one. */
export function proxyEnv(httpProxy: string | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const set = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some(k => env[k]);
	return httpProxy?.trim() && !set ? { HTTPS_PROXY: httpProxy.trim(), HTTP_PROXY: httpProxy.trim() } : {};
}

async function isFile(p: string): Promise<boolean> {
	try { return (await fs.stat(p)).isFile(); } catch { return false; }
}
