import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { globToRegex } from './manifest';

type Side = 'server' | 'client';
type FileSide = Side | 'shared';

interface Sides {
	api: Record<string, string[]>;
	events: Record<string, string[]>;
	natives: string[];
}

export interface Data {
	api: Map<string, Set<string>>;
	namespaces: Map<string, Set<string>>;
	events: Map<string, Set<string>>;
	natives: Set<string>;
}

const KEYS: Record<string, FileSide> = { server_scripts: 'server', client_scripts: 'client', shared_scripts: 'shared' };
const OTHER: Record<Side, Side> = { server: 'client', client: 'server' };

export function load(library: string): Data | undefined {
	let sides: Sides;
	try {
		sides = JSON.parse(fs.readFileSync(path.join(library, 'sides.json'), 'utf8')) as Sides;
	} catch {
		return undefined;
	}
	const api = new Map<string, Set<string>>();
	const namespaces = new Map<string, Set<string>>();
	for (const [name, list] of Object.entries(sides.api)) {
		const set = new Set(list.flatMap((s) => (s === 'shared' ? ['server', 'client'] : [s])));
		api.set(name, set);
		const parts = name.split('.');
		for (let i = 2; i < parts.length; i++) {
			const ns = parts.slice(0, i).join('.');
			const known = namespaces.get(ns) ?? new Set<string>();
			for (const side of set) known.add(side);
			namespaces.set(ns, known);
		}
	}
	const events = new Map(Object.entries(sides.events).map(([name, list]) => [name, new Set(list.flatMap((s) => (s === 'shared' ? ['server', 'client'] : [s])))]));
	return { api, namespaces, events, natives: new Set(sides.natives) };
}

export function manifestSide(file: string): FileSide | undefined {
	let dir = path.dirname(file);
	for (let depth = 0; depth < 8; depth++) {
		const manifest = path.join(dir, 'manifest.json');
		if (fs.existsSync(manifest)) {
			let json: Record<string, unknown>;
			try {
				json = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
			} catch {
				return undefined;
			}
			const relative = path.relative(dir, file).replace(/\\/g, '/');
			const found = new Set<FileSide>();
			for (const [key, side] of Object.entries(KEYS)) {
				const raw = json[key];
				const entries = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
				for (const entry of entries) {
					const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
					const hit = /[*?]/.test(normalized) ? globToRegex(normalized).test(relative) : normalized.toLowerCase() === relative.toLowerCase();
					if (hit) found.add(side);
				}
			}
			if (found.has('shared') || (found.has('server') && found.has('client'))) return 'shared';
			return found.has('server') ? 'server' : found.has('client') ? 'client' : undefined;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

export function mask(text: string): string {
	const out = text.split('');
	const blank = (from: number, to: number): void => {
		for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
	};
	const longClose = (at: number): number | undefined => {
		const open = /^\[(=*)\[/.exec(text.slice(at, at + 64));
		if (!open) return undefined;
		const close = text.indexOf(`]${open[1]}]`, at + open[0].length);
		return close < 0 ? text.length : close + open[1].length + 2;
	};
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (char === '-' && text[i + 1] === '-') {
			const end = longClose(i + 2) ?? (text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i));
			blank(i, end);
			i = end;
		} else if (char === '"' || char === "'") {
			let j = i + 1;
			while (j < text.length && text[j] !== char && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
			blank(i + 1, j);
			i = j + 1;
		} else if (char === '[' && (text[i + 1] === '[' || text[i + 1] === '=')) {
			const end = longClose(i);
			if (end === undefined) i++;
			else {
				blank(i, end);
				i = end;
			}
		} else i++;
	}
	return out.join('');
}

function definedNames(code: string): Set<string> {
	const names = new Set<string>();
	for (const m of code.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g)) names.add(m[1]);
	for (const m of code.matchAll(/\blocal\s+function\s+([A-Za-z_]\w*)/g)) names.add(m[1]);
	for (const m of code.matchAll(/\blocal\s+([A-Za-z_][\w\s,<>]*?)(?:=|\n|$)/g)) {
		for (const part of m[1].split(',')) names.add(part.replace(/<\w+>/g, '').trim());
	}
	for (const m of code.matchAll(/\bfunction\s*[\w.:]*\s*\(([^)]*)\)/g)) for (const p of m[1].split(',')) names.add(p.trim());
	for (const m of code.matchAll(/\bfor\s+([\w\s,]+?)\s+(?:=|in)\b/g)) for (const p of m[1].split(',')) names.add(p.trim());
	return names;
}

const sideLabel = (side: Side): string => (side === 'server' ? 'server' : 'client');

export function check(text: string, fileSide: FileSide, data: Data): { start: number; end: number; message: string; severity: vscode.DiagnosticSeverity }[] {
	const code = mask(text);
	const results: { start: number; end: number; message: string; severity: vscode.DiagnosticSeverity }[] = [];
	const severity = fileSide === 'shared' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
	const where = fileSide === 'shared' ? 'a shared script (it also runs on the other side)' : `a ${fileSide} script`;
	const allowed = (sides: Set<string>): Side | undefined => {
		if (fileSide === 'shared') return sides.size === 1 ? ([...sides][0] as Side) : undefined;
		return sides.has(fileSide) ? undefined : OTHER[fileSide];
	};

	for (const m of code.matchAll(/(?<![\w.:])lsmp((?:\s*\.\s*[A-Za-z_]\w*)+)/g)) {
		const parts = m[1].split('.').map((p) => p.trim()).filter(Boolean);
		for (let n = parts.length; n >= 1; n--) {
			const name = ['lsmp', ...parts.slice(0, n)].join('.');
			const sides = data.api.get(name) ?? data.namespaces.get(name);
			if (!sides) continue;
			const only = allowed(sides);
			if (only) results.push({ start: m.index, end: m.index + m[0].length, message: `${name} is ${sideLabel(only)}-only: not available in ${where}.`, severity });
			break;
		}
	}

	if (fileSide !== 'client') {
		const defined = definedNames(code);
		for (const m of code.matchAll(/(?<![\w.:])([a-z_][A-Za-z0-9_]*)\s*\(/g)) {
			const name = m[1];
			if (!data.natives.has(name) || defined.has(name)) continue;
			if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
			results.push({ start: m.index, end: m.index + name.length, message: `${name} is a GTA V native: natives only exist in client scripts, not in ${where}.`, severity });
		}
	}

	for (const m of code.matchAll(/(?<![\w.:])lsmp\s*\.\s*(?:on|once)\s*\(\s*(["'])/g)) {
		const open = m.index + m[0].length;
		const close = text.indexOf(m[1], open);
		if (close < 0) continue;
		const event = text.slice(open, close);
		const sides = data.events.get(event);
		if (!sides) continue;
		const only = allowed(sides);
		if (only) results.push({ start: open - 1, end: close + 1, message: `Engine event "${event}" only fires on the ${sideLabel(only)}: this handler never runs in ${where}.`, severity });
	}
	if (fileSide !== 'shared') return results;
	const seen = new Set<string>();
	return results
		.sort((a, b) => a.start - b.start)
		.filter((r) => {
			const key = r.message.split(' ')[0];
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

export function registerSideChecks(context: vscode.ExtensionContext, library: () => string): void {
	const collection = vscode.languages.createDiagnosticCollection('lsmp-sides');
	let data: Data | undefined;
	let loadedFrom = '';
	const getData = (): Data | undefined => {
		const current = library();
		if (current !== loadedFrom) {
			data = load(current);
			loadedFrom = current;
		}
		return data;
	};

	const refresh = (document: vscode.TextDocument): void => {
		if (document.languageId !== 'lua' || document.uri.scheme !== 'file') return;
		const sides = getData();
		const fileSide = manifestSide(document.uri.fsPath);
		if (!sides || !fileSide) return void collection.delete(document.uri);
		collection.set(
			document.uri,
			check(document.getText(), fileSide, sides).map((r) => {
				const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)), r.message, r.severity);
				diagnostic.source = 'LS:MP';
				diagnostic.code = 'wrong-side';
				return diagnostic;
			}),
		);
	};
	const refreshOpen = (): void => vscode.workspace.textDocuments.forEach(refresh);

	let pending: NodeJS.Timeout | undefined;
	const typing = new Map<string, vscode.TextDocument>();
	let typingTimer: NodeJS.Timeout | undefined;
	const refreshSoon = (document: vscode.TextDocument): void => {
		typing.set(document.uri.toString(), document);
		clearTimeout(typingTimer);
		typingTimer = setTimeout(() => {
			for (const queued of typing.values()) if (!queued.isClosed) refresh(queued);
			typing.clear();
		}, 300);
	};
	context.subscriptions.push(
		collection,
		vscode.workspace.onDidOpenTextDocument(refresh),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (path.basename(event.document.uri.fsPath).toLowerCase() === 'manifest.json') {
				clearTimeout(pending);
				pending = setTimeout(refreshOpen, 300);
			} else if (event.contentChanges.length && event.document.languageId === 'lua') refreshSoon(event.document);
		}),
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (path.basename(document.uri.fsPath).toLowerCase() === 'manifest.json') refreshOpen();
		}),
		vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
		{ dispose: () => (clearTimeout(pending), clearTimeout(typingTimer)) },
	);
	refreshOpen();
}

