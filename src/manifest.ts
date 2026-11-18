import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const SCRIPT_KEYS: Record<string, string[]> = {
	client_scripts: ['.lua', '.js'],
	server_scripts: ['.lua', '.js', '.mjs', '.cjs'],
	shared_scripts: ['.lua', '.js'],
};
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '.svn', '.hg']);

export function listFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIPPED_FOLDERS.has(entry.name)) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
			} else out.push(`${prefix}${entry.name}`);
		}
	};
	walk(root, '');
	return out;
}

export function globToRegex(pattern: string): RegExp {
	let source = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '*' && pattern[i + 1] === '*') {
			source += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
			i += pattern[i + 2] === '/' ? 2 : 1;
		} else if (char === '*') source += '[^/]*';
		else if (char === '?') source += '[^/]';
		else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${source}$`, 'i');
}

function rangeOf(document: vscode.TextDocument, key: string, value: string): vscode.Range {
	const text = document.getText();
	const keyAt = text.indexOf(`"${key}"`);
	const literal = JSON.stringify(value);
	const at = text.indexOf(literal, keyAt < 0 ? 0 : keyAt);
	if (at < 0) {
		const fallback = keyAt < 0 ? 0 : keyAt;
		return new vscode.Range(document.positionAt(fallback), document.positionAt(fallback + key.length + 2));
	}
	return new vscode.Range(document.positionAt(at), document.positionAt(at + literal.length));
}

export function check(document: vscode.TextDocument): vscode.Diagnostic[] {
	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(document.getText()) as Record<string, unknown>;
	} catch {
		return [];
	}
	if (!manifest || typeof manifest !== 'object' || !Object.keys(SCRIPT_KEYS).some((key) => key in manifest)) return [];

	const root = path.dirname(document.uri.fsPath);
	const files = listFiles(root);
	const diagnostics: vscode.Diagnostic[] = [];
	const report = (key: string, value: string, message: string, severity = vscode.DiagnosticSeverity.Error): void => {
		const diagnostic = new vscode.Diagnostic(rangeOf(document, key, value), message, severity);
		diagnostic.source = 'LS:MP';
		diagnostics.push(diagnostic);
	};

	for (const [key, extensions] of Object.entries(SCRIPT_KEYS)) {
		const raw = manifest[key];
		if (raw === undefined) continue;
		const entries = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
		for (const entry of entries) {
			const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
			if (path.isAbsolute(entry) || normalized.split('/').includes('..')) {
				report(key, entry, `"${entry}" leaves the resource folder: paths must stay inside it.`);
				continue;
			}
			const isPattern = /[*?]/.test(normalized);
			const matches = isPattern ? files.filter((file) => globToRegex(normalized).test(file)) : files.filter((file) => file.toLowerCase() === normalized.toLowerCase());
			if (matches.length === 0) {
				report(key, entry, isPattern ? `"${entry}" matches no file.` : `"${entry}" does not exist.`);
				continue;
			}
			const wrong = matches.filter((file) => !extensions.includes(path.extname(file).toLowerCase()));
			if (wrong.length) {
				report(key, entry, `${key} accepts ${extensions.join(', ')} files: ${wrong.slice(0, 3).join(', ')}${wrong.length > 3 ? '…' : ''}`, vscode.DiagnosticSeverity.Warning);
			}
		}
	}
	return diagnostics;
}

export function registerManifestChecks(context: vscode.ExtensionContext): void {
	const collection = vscode.languages.createDiagnosticCollection('lsmp-manifest');
	const isManifest = (uri: vscode.Uri): boolean => path.basename(uri.fsPath).toLowerCase() === 'manifest.json';
	const ignored = /[\\/](?:node_modules|\.git)[\\/]/i;

	const lines = (text: string): number[] => {
		const starts = [0];
		for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
		return starts;
	};
	const fromDisk = (uri: vscode.Uri): vscode.TextDocument | undefined => {
		let text: string;
		try {
			text = fs.readFileSync(uri.fsPath, 'utf8');
		} catch {
			return undefined;
		}
		const starts = lines(text);
		const positionAt = (offset: number): vscode.Position => {
			let low = 0;
			let high = starts.length - 1;
			while (low < high) {
				const mid = (low + high + 1) >> 1;
				if (starts[mid] <= offset) low = mid;
				else high = mid - 1;
			}
			return new vscode.Position(low, offset - starts[low]);
		};
		return { uri, getText: () => text, positionAt } as unknown as vscode.TextDocument;
	};

	const refresh = (document: vscode.TextDocument): void => {
		if (isManifest(document.uri) && !ignored.test(document.uri.fsPath)) collection.set(document.uri, check(document));
	};
	const refreshUri = (uri: vscode.Uri): void => {
		const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		const document = open ?? fromDisk(uri);
		if (document) refresh(document);
		else collection.delete(uri);
	};
	const refreshAll = async (): Promise<void> => {
		for (const uri of await vscode.workspace.findFiles('**/manifest.json', '**/{node_modules,.git}/**', 500)) refreshUri(uri);
	};
	const owner = (file: string): vscode.Uri | undefined => {
		let dir = path.dirname(file);
		for (let depth = 0; depth < 8; depth++) {
			const manifest = path.join(dir, 'manifest.json');
			if (fs.existsSync(manifest)) return vscode.Uri.file(manifest);
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return undefined;
	};

	const queued = new Map<string, vscode.Uri>();
	let pending: NodeJS.Timeout | undefined;
	const queue = (uri: vscode.Uri | undefined): void => {
		if (!uri) return;
		queued.set(uri.toString(), uri);
		clearTimeout(pending);
		pending = setTimeout(() => {
			for (const target of queued.values()) refreshUri(target);
			queued.clear();
		}, 300);
	};
	const onScript = (uri: vscode.Uri): void => {
		if (!ignored.test(uri.fsPath)) queue(owner(uri.fsPath));
	};

	const scripts = vscode.workspace.createFileSystemWatcher('**/*.{lua,js,mjs,cjs}', false, true, false);
	const manifests = vscode.workspace.createFileSystemWatcher('**/manifest.json');
	context.subscriptions.push(
		collection,
		scripts,
		manifests,
		scripts.onDidCreate(onScript),
		scripts.onDidDelete(onScript),
		manifests.onDidCreate(queue),
		manifests.onDidChange(queue),
		manifests.onDidDelete((uri) => collection.delete(uri)),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length && isManifest(event.document.uri)) queue(event.document.uri);
		}),
		vscode.workspace.onDidRenameFiles((event) => {
			for (const file of event.files) {
				queue(owner(file.oldUri.fsPath));
				queue(owner(file.newUri.fsPath));
			}
		}),
		{ dispose: () => clearTimeout(pending) },
	);
	void refreshAll();
}
