import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { load, manifestSide, mask, type Data } from './sides';

type Role = 'emit' | 'handle';
type FileSide = 'server' | 'client' | 'shared' | undefined;

export interface Span {
	start: number;
	end: number;
}

export interface Use {
	uri: vscode.Uri;
	start: number;
	end: number;
	name: string;
	role: Role;
	channels: string[];
	fn: string;
	side: FileSide;
	args: Span[];
	params: string[];
	returns: Span[];
}

interface Kind {
	role: Role;
	nameArg: number;
	channels: (side: FileSide) => string[];
}

const both = (prefix: string, side: FileSide): string[] => (side === 'server' || side === 'client' ? [`${prefix}:${side}`] : [`${prefix}:server`, `${prefix}:client`]);

const KINDS: Record<string, Kind> = {
	emitServer: { role: 'emit', nameArg: 0, channels: () => ['net:to-server'] },
	onClient: { role: 'handle', nameArg: 0, channels: () => ['net:to-server'] },
	offClient: { role: 'handle', nameArg: 0, channels: () => ['net:to-server'] },
	emitClient: { role: 'emit', nameArg: 1, channels: () => ['net:to-client'] },
	emitAllClients: { role: 'emit', nameArg: 0, channels: () => ['net:to-client'] },
	emitDimensionClients: { role: 'emit', nameArg: 1, channels: () => ['net:to-client'] },
	onServer: { role: 'handle', nameArg: 0, channels: () => ['net:to-client'] },
	offServer: { role: 'handle', nameArg: 0, channels: () => ['net:to-client'] },
	emit: { role: 'emit', nameArg: 0, channels: (side) => both('local', side) },
	on: { role: 'handle', nameArg: 0, channels: (side) => both('local', side) },
	once: { role: 'handle', nameArg: 0, channels: (side) => both('local', side) },
	off: { role: 'handle', nameArg: 0, channels: (side) => both('local', side) },
	callServer: { role: 'emit', nameArg: 0, channels: () => ['call:server'] },
	callClient: { role: 'emit', nameArg: 1, channels: () => ['call:client'] },
	call: { role: 'emit', nameArg: 0, channels: (side) => both('call', side) },
	onCall: { role: 'handle', nameArg: 0, channels: (side) => both('call', side) },
	offCall: { role: 'handle', nameArg: 0, channels: (side) => both('call', side) },
};

const CALL = new RegExp(`(?<![\\w.:])lsmp\\s*\\.\\s*(${Object.keys(KINDS).join('|')})\\s*\\(`, 'g');

function argumentStart(code: string, from: number, index: number): number | undefined {
	let depth = 0;
	let arg = 0;
	for (let i = from; i < code.length; i++) {
		const char = code[i];
		if (arg === index && depth === 0 && !/\s/.test(char)) return i;
		if ('({['.includes(char)) depth++;
		else if (')}]'.includes(char)) {
			if (depth === 0) return undefined;
			depth--;
		} else if (char === ',' && depth === 0) arg++;
	}
	return undefined;
}

function argumentsOf(code: string, from: number): Span[] {
	const spans: Span[] = [];
	let depth = 0;
	let start = from;
	for (let i = from; i < code.length; i++) {
		const char = code[i];
		if ('({['.includes(char)) depth++;
		else if (')}]'.includes(char)) {
			if (depth === 0) {
				if (code.slice(start, i).trim()) spans.push(trimSpan(code, start, i));
				return spans;
			}
			depth--;
		} else if (char === ',' && depth === 0) {
			spans.push(trimSpan(code, start, i));
			start = i + 1;
		}
	}
	return spans;
}

function trimSpan(code: string, start: number, end: number): Span {
	while (start < end && /\s/.test(code[start])) start++;
	while (end > start && /\s/.test(code[end - 1])) end--;
	return { start, end };
}

const BLOCK = /\b(function|if|do|repeat|end|until|return|else|elseif)\b/g;

function firstValue(expr: string): string {
	let depth = 0;
	let quote = '';
	for (let i = 0; i < expr.length; i++) {
		const char = expr[i];
		if (quote) {
			if (char === quote) quote = '';
		} else if (char === '"' || char === "'") quote = char;
		else if ('([{'.includes(char)) depth++;
		else if (')]}'.includes(char)) depth--;
		else if (char === ',' && depth === 0) return expr.slice(0, i);
	}
	return expr;
}

export function handlerReturns(code: string, start: number): Span[] {
	const stack: string[] = [];
	const spans: Span[] = [];
	let pendingReturn: number | undefined;
	BLOCK.lastIndex = start;
	for (let m = BLOCK.exec(code); m; m = BLOCK.exec(code)) {
		const word = m[1];
		if (pendingReturn !== undefined && ['end', 'until', 'else', 'elseif'].includes(word)) {
			const expr = code.slice(pendingReturn, m.index);
			const first = firstValue(expr);
			spans.push(trimSpan(code, pendingReturn, pendingReturn + first.length));
			pendingReturn = undefined;
		}
		if (word === 'function') stack.push('function');
		else if (word === 'if' || word === 'do' || word === 'repeat') stack.push('block');
		else if (word === 'end' || word === 'until') {
			stack.pop();
			if (!stack.length) break;
		} else if (word === 'return' && stack.filter((k) => k === 'function').length === 1) pendingReturn = m.index + m[0].length;
	}
	return spans.filter((span) => span.end > span.start);
}

function nameAt(text: string, code: string, at: number): { start: number; end: number; name: string } | undefined {
	let i = at;
	if (code[i] === '{') {
		const field = /^\{\s*name\s*[=:]\s*/.exec(code.slice(i, i + 64));
		if (!field) return undefined;
		i += field[0].length;
	}
	const quote = text[i];
	if (quote !== '"' && quote !== "'") return undefined;
	const close = text.indexOf(quote, i + 1);
	if (close < 0 || text.slice(i + 1, close).includes('\n')) return undefined;
	return { start: i, end: close + 1, name: text.slice(i + 1, close) };
}

const isJs = (file: string): boolean => /\.(?:m|c)?js$/i.test(file);

function maskJs(text: string): string {
	const out = text.split('');
	const blank = (from: number, to: number): void => {
		for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
	};
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (char === '/' && text[i + 1] === '/') {
			const newline = text.indexOf('\n', i);
			const end = newline < 0 ? text.length : newline;
			blank(i, end);
			i = end;
		} else if (char === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2);
			const end = close < 0 ? text.length : close + 2;
			blank(i, end);
			i = end;
		} else if (char === '"' || char === "'" || char === '`') {
			let j = i + 1;
			while (j < text.length && text[j] !== char && (char === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
			blank(i + 1, j);
			i = j + 1;
		} else i++;
	}
	return out.join('');
}

export function scan(uri: vscode.Uri, text: string, side: FileSide, engineEvents: Set<string>): Use[] {
	const code = isJs(uri.fsPath) ? maskJs(text) : mask(text);
	const uses: Use[] = [];
	for (const m of code.matchAll(CALL)) {
		const fn = m[1];
		const kind = KINDS[fn];
		const at = argumentStart(code, m.index + m[0].length, kind.nameArg);
		if (at === undefined) continue;
		const found = nameAt(text, code, at);
		if (!found) continue;
		if ((fn === 'on' || fn === 'once' || fn === 'off') && engineEvents.has(found.name)) continue;
		const all = argumentsOf(code, m.index + m[0].length);
		const nameIndex = all.findIndex((span) => found.start >= span.start && found.start < span.end);
		const args = kind.role === 'emit' && nameIndex >= 0 ? all.slice(nameIndex + 1) : [];
		let params: string[] = [];
		let returns: Span[] = [];
		if (kind.role === 'handle' && nameIndex >= 0 && all[nameIndex + 1]) {
			const handler = /^function\s*\(([^)]*)\)/.exec(code.slice(all[nameIndex + 1].start, all[nameIndex + 1].end));
			if (handler) params = handler[1].split(',').map((p) => p.trim()).filter(Boolean);
			if (handler && fn === 'onCall' && !isJs(uri.fsPath)) returns = handlerReturns(code, all[nameIndex + 1].start);
		}
		uses.push({ uri, ...found, role: kind.role, channels: kind.channels(side), fn, side, args, params, returns });
	}
	return uses;
}

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const current = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = current;
		}
	}
	return row[b.length];
}

const HANDLERS_OF: Record<string, string> = { emitServer: 'lsmp.onClient (server)', emitClient: 'lsmp.onServer (client)', emitAllClients: 'lsmp.onServer (client)', emitDimensionClients: 'lsmp.onServer (client)', emit: 'lsmp.on', callServer: 'lsmp.onCall (server)', callClient: 'lsmp.onCall (client)', call: 'lsmp.onCall' };

export class EventIndex {
	private readonly files = new Map<string, Use[]>();
	private readonly collection = vscode.languages.createDiagnosticCollection('lsmp-events');
	private engineEvents = new Set<string>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	setData(data: Data | undefined): void {
		this.engineEvents = new Set(data ? data.events.keys() : []);
	}

	all(): Use[] {
		return [...this.files.values()].flat();
	}

	update(uri: vscode.Uri, text: string): void {
		const side = manifestSide(uri.fsPath);
		this.files.set(uri.toString(), isJs(uri.fsPath) && !side ? [] : scan(uri, text, side, this.engineEvents));
	}

	remove(uri: vscode.Uri): void {
		this.files.delete(uri.toString());
		this.collection.delete(uri);
	}

	counterparts(use: Use): Use[] {
		const wanted: Role = use.role === 'emit' ? 'handle' : 'emit';
		return this.all().filter((u) => u.role === wanted && u.name === use.name && u.channels.some((c) => use.channels.includes(c)));
	}

	same(use: Use): Use[] {
		return this.all().filter((u) => u.name === use.name && u.channels.some((c) => use.channels.includes(c)));
	}

	at(document: vscode.TextDocument, position: vscode.Position): Use | undefined {
		const offset = document.offsetAt(position);
		return this.files.get(document.uri.toString())?.find((u) => offset >= u.start && offset <= u.end);
	}

	diagnose(): void {
		this.changed.fire();
		const byFile = new Map<string, vscode.Diagnostic[]>();
		const handled = this.all().filter((u) => u.role === 'handle');
		for (const [key, uses] of this.files) {
			const diagnostics: vscode.Diagnostic[] = [];
			const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
			for (const use of uses) {
				if (use.role !== 'emit' || this.counterparts(use).length) continue;
				const candidates = [...new Set(handled.filter((h) => h.channels.some((c) => use.channels.includes(c))).map((h) => h.name))];
				const best = candidates.map((name) => ({ name, d: distance(name, use.name) })).sort((a, b) => a.d - b.d)[0];
				const hint = best && best.d <= Math.max(2, Math.floor(use.name.length / 4)) ? ` Did you mean "${best.name}"?` : '';
				const range = document ? new vscode.Range(document.positionAt(use.start), document.positionAt(use.end)) : this.rangeFromDisk(use);
				const diagnostic = new vscode.Diagnostic(range, `No ${HANDLERS_OF[use.fn] ?? 'handler'} for "${use.name}" in the workspace.${hint}`, vscode.DiagnosticSeverity.Warning);
				diagnostic.source = 'LS:MP';
				diagnostic.code = 'unhandled-event';
				diagnostics.push(diagnostic);
			}
			byFile.set(key, diagnostics);
		}
		this.collection.clear();
		for (const [key, diagnostics] of byFile) if (diagnostics.length) this.collection.set(vscode.Uri.parse(key), diagnostics);
	}

	private rangeFromDisk(use: Use): vscode.Range {
		try {
			const text = fs.readFileSync(use.uri.fsPath, 'utf8');
			const toPosition = (offset: number): vscode.Position => {
				const before = text.slice(0, offset).split('\n');
				return new vscode.Position(before.length - 1, before[before.length - 1].length);
			};
			return new vscode.Range(toPosition(use.start), toPosition(use.end));
		} catch {
			return new vscode.Range(0, 0, 0, 0);
		}
	}

	location(use: Use): vscode.Location {
		const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === use.uri.toString());
		const range = document ? new vscode.Range(document.positionAt(use.start), document.positionAt(use.end)) : this.rangeFromDisk(use);
		return new vscode.Location(use.uri, range);
	}

	dispose(): void {
		this.changed.dispose();
		this.collection.dispose();
	}

}

export function registerEventIndex(context: vscode.ExtensionContext, library: () => string): EventIndex {
	const index = new EventIndex();
	let loadedFrom = '';
	const ensureData = (): void => {
		if (library() === loadedFrom) return;
		loadedFrom = library();
		index.setData(load(loadedFrom));
	};

	let pending: NodeJS.Timeout | undefined;
	const diagnoseSoon = (): void => {
		clearTimeout(pending);
		pending = setTimeout(() => index.diagnose(), 250);
	};
	const indexFile = async (uri: vscode.Uri): Promise<void> => {
		const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		try {
			index.update(uri, open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8'));
		} catch {
			index.remove(uri);
		}
	};
	const indexAll = async (): Promise<void> => {
		ensureData();
		for (const uri of await vscode.workspace.findFiles('**/*.{lua,js,mjs,cjs}', '**/{node_modules,.git,docs,dist}/**', 5000)) await indexFile(uri);
		index.diagnose();
	};

	const isScript = (uri: vscode.Uri): boolean => uri.scheme === 'file' && /\.(?:lua|m?js|cjs)$/i.test(uri.fsPath);
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.{lua,js,mjs,cjs,json}');
	const onFile = (uri: vscode.Uri): void => {
		if (path.basename(uri.fsPath).toLowerCase() === 'manifest.json') return void indexAll();
		if (!isScript(uri)) return;
		void indexFile(uri).then(diagnoseSoon);
	};

	const selector: vscode.DocumentSelector = { language: 'lua', scheme: 'file' };
	context.subscriptions.push(
		index,
		watcher,
		watcher.onDidCreate(onFile),
		watcher.onDidChange(onFile),
		watcher.onDidDelete((uri) => {
			if (isScript(uri)) {
				index.remove(uri);
				diagnoseSoon();
			}
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (!isScript(event.document.uri)) return;
			ensureData();
			index.update(event.document.uri, event.document.getText());
			diagnoseSoon();
		}),
		vscode.languages.registerDefinitionProvider(selector, {
			provideDefinition(document, position) {
				const use = index.at(document, position);
				return use ? index.counterparts(use).map((u) => index.location(u)) : undefined;
			},
		}),
		vscode.languages.registerReferenceProvider(selector, {
			provideReferences(document, position) {
				const use = index.at(document, position);
				return use ? index.same(use).map((u) => index.location(u)) : undefined;
			},
		}),
		vscode.languages.registerHoverProvider(selector, {
			provideHover(document, position) {
				const use = index.at(document, position);
				if (!use) return undefined;
				const others = index.same(use);
				const handlers = others.filter((u) => u.role === 'handle');
				const emitters = others.filter((u) => u.role === 'emit');
				const where = (list: Use[]): string =>
					list
						.slice(0, 8)
						.map((u) => `- \`lsmp.${u.fn}\` in ${vscode.workspace.asRelativePath(u.uri)}:${index.location(u).range.start.line + 1}`)
						.join('\n');
				const text = new vscode.MarkdownString(
					[`**"${use.name}"**: ${handlers.length} handler${handlers.length === 1 ? '' : 's'}, ${emitters.length} emitter${emitters.length === 1 ? '' : 's'}`, handlers.length ? `\nHandlers:\n${where(handlers)}` : '', emitters.length ? `\nEmitters:\n${where(emitters)}` : '', '\nF12: go to the other side · Shift+F12: all uses'].join('\n'),
				);
				return new vscode.Hover(text, new vscode.Range(document.positionAt(use.start), document.positionAt(use.end)));
			},
		}),
		{ dispose: () => clearTimeout(pending) },
	);
	void indexAll();
	return index;
}
