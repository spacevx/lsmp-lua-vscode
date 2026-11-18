import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const SCRIPT_KEYS: Record<string, string[]> = {
	client_scripts: ['.lua', '.js'],
	server_scripts: ['.lua', '.js', '.mjs', '.cjs'],
	shared_scripts: ['.lua', '.js'],
};
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '.svn', '.hg']);

function listFiles(root: string): string[] {
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

function globToRegex(pattern: string): RegExp {
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

	const refresh = (document: vscode.TextDocument): void => {
		if (isManifest(document.uri)) collection.set(document.uri, check(document));
	};
	const refreshUri = async (uri: vscode.Uri): Promise<void> => {
		try {
			refresh(await vscode.workspace.openTextDocument(uri));
		} catch {
			collection.delete(uri);
		}
	};
	const refreshAll = async (): Promise<void> => {
		for (const uri of await vscode.workspace.findFiles('**/manifest.json', '**/{node_modules,.git}/**', 500)) await refreshUri(uri);
	};

	const watcher = vscode.workspace.createFileSystemWatcher('**/*');
	let pending: NodeJS.Timeout | undefined;
	const refreshSoon = (uri: vscode.Uri): void => {
		if (isManifest(uri)) return void refreshUri(uri);
		clearTimeout(pending);
		pending = setTimeout(() => void refreshAll(), 300);
	};

	context.subscriptions.push(
		collection,
		watcher,
		watcher.onDidCreate(refreshSoon),
		watcher.onDidDelete((uri) => (isManifest(uri) ? collection.delete(uri) : refreshSoon(uri))),
		vscode.workspace.onDidOpenTextDocument(refresh),
		vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
		vscode.workspace.onDidRenameFiles(() => void refreshAll()),
		{ dispose: () => clearTimeout(pending) },
	);
	void refreshAll();
}
