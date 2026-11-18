import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EventIndex, Span } from './events';

const VECTORS = new Set(['vector2', 'vector3', 'vector4', 'quaternion']);
const SAME_TYPE_METHODS = new Set(['normalize', 'cross', 'lerp', 'add', 'sub', 'mul', 'inverse', 'conjugate']);
const NUMBER_METHODS = new Set(['length', 'length2', 'distance', 'distance2', 'dot']);
const ALIASES: Record<string, string> = { Vector2: 'vector2', Vector3: 'vector3', Vector4: 'vector4', Quaternion: 'quaternion' };
const CALLERS = new Set(['call', 'callServer', 'callClient']);
const HANDLERS = new Set(['onClient', 'onServer', 'on', 'once', 'onCall']);
const VALID_TYPE = /^[\w.?|\[\]{}<>:, ]+$/;

const normalize = (type: string): string => type.replace(/\b(Vector2|Vector3|Vector4|Quaternion)\b/g, (name) => ALIASES[name]);
const base = (type: string): string => type.replace(/\?$/, '');

function splitTop(expr: string, operators: string[]): [string, string, string] | undefined {
	let depth = 0;
	let quote = '';
	for (let i = expr.length - 1; i > 0; i--) {
		const char = expr[i];
		if (quote) {
			if (char === quote) quote = '';
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (')]}'.includes(char)) depth++;
		else if ('([{'.includes(char)) depth--;
		else if (depth === 0) {
			for (const op of operators) {
				if (expr.slice(i - op.length + 1, i + 1) === op && expr[i - op.length] !== op[0]) {
					const left = expr.slice(0, i - op.length + 1).trim();
					const right = expr.slice(i + 1).trim();
					if (left && right) return [left, op, right];
				}
			}
		}
	}
	return undefined;
}

function matchingOpen(expr: string, close: number): number {
	let depth = 0;
	for (let i = close; i >= 0; i--) {
		if (expr[i] === ')') depth++;
		else if (expr[i] === '(' && --depth === 0) return i;
	}
	return -1;
}

function splitList(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote = '';
	let current = '';
	for (const char of body) {
		if (quote) {
			if (char === quote) quote = '';
		} else if (char === '"' || char === "'") quote = char;
		else if ('([{'.includes(char)) depth++;
		else if (')]}'.includes(char)) depth--;
		else if ((char === ',' || char === ';') && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current);
	return parts.map((p) => p.trim()).filter(Boolean);
}

export class Inferrer {
	constructor(private readonly returns: Record<string, string>) {}

	private table(expr: string, text: string, offset: number, depth: number): string {
		if (!expr.endsWith('}')) return 'table';
		const parts = splitList(expr.slice(1, -1));
		if (!parts.length || parts.length > 16) return 'table';
		const named = parts.map((part) => /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(part));
		if (named.every(Boolean)) {
			const fields = named.map((m) => `${(m as RegExpExecArray)[1]}: ${this.infer((m as RegExpExecArray)[2], text, offset, depth + 1) ?? 'any'}`);
			return `{ ${fields.join(', ')} }`;
		}
		if (named.some(Boolean) || parts.some((p) => p.startsWith('['))) return 'table';
		const items = new Set(parts.map((part) => this.infer(part, text, offset, depth + 1) ?? 'any'));
		return items.size === 1 ? `${[...items][0]}[]` : 'table';
	}

	infer(raw: string, text: string, offset: number, depth = 0): string | undefined {
		let expr = raw.trim();
		if (depth > 6 || !expr) return undefined;
		while (expr.startsWith('(') && matchingOpen(expr, expr.length - 1) === 0) expr = expr.slice(1, -1).trim();

		if (/^(["']).*\1$/s.test(expr) || /^\[=*\[/.test(expr)) return 'string';
		if (/^-?(?:0x[\da-f]+|\d+)$/i.test(expr)) return 'integer';
		if (/^-?(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?$/i.test(expr)) return 'number';
		if (expr === 'true' || expr === 'false' || expr.startsWith('not ')) return 'boolean';
		if (expr === 'nil') return 'nil';
		if (expr.startsWith('{')) return this.table(expr, text, offset, depth);
		if (/^function\b/.test(expr)) return 'function';
		if (expr.startsWith('#')) return 'integer';

		if (splitTop(expr, ['==', '~=', '<=', '>=', '<', '>'])) return 'boolean';
		if (splitTop(expr, ['..'])) return 'string';
		const logical = splitTop(expr, [' or ']);
		if (logical) {
			const right = this.infer(logical[2], text, offset, depth + 1);
			return right;
		}
		const arithmetic = splitTop(expr, ['+', '-', '*', '/', '//', '%']);
		if (arithmetic) {
			const left = this.infer(arithmetic[0], text, offset, depth + 1);
			const right = this.infer(arithmetic[2], text, offset, depth + 1);
			if (left && VECTORS.has(base(left))) return base(left);
			if (right && VECTORS.has(base(right))) return base(right);
			if (left === 'integer' && right === 'integer' && !['/'].includes(arithmetic[1])) return 'integer';
			return left || right ? 'number' : undefined;
		}
		if (expr.startsWith('-')) return this.infer(expr.slice(1), text, offset, depth + 1);

		if (expr.endsWith(')')) {
			const open = matchingOpen(expr, expr.length - 1);
			if (open <= 0) return undefined;
			const callee = expr.slice(0, open).replace(/\s+/g, '');
			const method = /^(.*):(\w+)$/.exec(callee);
			if (method) {
				const owner = this.infer(method[1], text, offset, depth + 1);
				if (!owner || !VECTORS.has(base(owner))) return undefined;
				if (SAME_TYPE_METHODS.has(method[2])) return base(owner);
				if (NUMBER_METHODS.has(method[2]) || method[2] === 'unpack') return 'number';
				if (method[2] === 'toString') return 'string';
				return undefined;
			}
			const known = this.returns[callee];
			return known ? normalize(known) : undefined;
		}

		const field = /^(.*)\.(x|y|z|w)$/.exec(expr);
		if (field) {
			const owner = this.infer(field[1], text, offset, depth + 1);
			if (owner && VECTORS.has(base(owner))) return 'number';
		}

		if (/^[A-Za-z_]\w*$/.test(expr)) {
			const before = text.slice(0, offset);
			const assignment = new RegExp(`(?:^|[\\n;]|\\b(?:then|do|else)\\b)[ \\t]*(?:local[ \\t]+)?${expr}[ \\t]*(?:<\\w+>)?[ \\t]*=(?!=)[ \\t]*([^\\n]+)`, 'g');
			let last: RegExpExecArray | undefined;
			for (const m of before.matchAll(assignment)) last = m as RegExpExecArray;
			if (last) {
				const lineStart = before.lastIndexOf('\n', last.index + (before[last.index] === '\n' ? 0 : -1));
				const previous = before.slice(before.lastIndexOf('\n', lineStart - 1) + 1, Math.max(lineStart, 0));
				const annotated = /^\s*---\s*@type\s+([^#\n]+?)\s*(?:#.*)?$/.exec(previous)?.[1];
				if (annotated && !annotated.includes(',') && VALID_TYPE.test(annotated)) return normalize(annotated);
				const value = last[1].replace(/--.*$/, '').trim();
				return this.infer(value, text, last.index + last[0].length - last[1].length, depth + 1);
			}
		}
		return undefined;
	}
}

function hoverType(hovers: vscode.Hover[] | undefined): string | undefined {
	const markdown = (hovers ?? [])
		.flatMap((h) => h.contents)
		.map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
		.join('\n');
	const block = /```lua\n([\s\S]*?)```/.exec(markdown)?.[1] ?? '';
	const lines = block.split('\n').map((line) => line.trim());
	const firstLine = lines[0] ?? '';
	const returned = /->\s*(?:\d+\.\s*)?([^\n]+)/.exec(block)?.[1]?.trim();
	let declared = /^(?:local|global|\(parameter\)|\(field\)|\(global\)|\(enum\)|field|param|enum)?\s*[\w.:[\]"']+\s*:\s*(.+)$/.exec(firstLine)?.[1]?.trim();
	if (declared === '{') {
		const fields: string[] = [];
		for (const line of lines.slice(1)) {
			if (line.startsWith('}')) break;
			const field = /^([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*(?:=.*)?,?$/.exec(line);
			if (!field) return 'table';
			fields.push(`${field[1]}: ${field[2].replace(/,$/, '').trim()}`);
		}
		declared = fields.length ? `{ ${fields.join(', ')} }` : 'table';
	}
	const type = (firstLine.startsWith('function') ? returned : declared)?.replace(/\s*=\s*.*$/, '');
	return type && type !== 'unknown' && type !== 'any' && type.length < 200 && VALID_TYPE.test(type) ? normalize(type) : undefined;
}

const unionOf = (types: Set<string>): string => [...types].sort((x, y) => Number(x === 'nil') - Number(y === 'nil')).join('|');

const isReference = (expr: string): boolean => /^[A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*$/.test(expr.trim());

const literal = (name: string): string => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const IDENTIFIER = /^[A-Za-z_]\w*$/;

const CALL_SIGNATURES: Record<string, string> = { call: 'name, ...', callServer: 'name, ...', callClient: 'playerId, name, ...' };
const HANDLER_SIGNATURES: Record<string, string> = { on: 'name, fn, filter', once: 'name, fn, filter', onClient: 'name, fn', onServer: 'name, fn', onCall: 'name, fn' };

interface HandlerTypes {
	params: string[];
	types: (string | null)[];
}

export interface EventTypeData {
	handlers: Map<string, Map<string, HandlerTypes>>;
	calls: Map<string, Map<string, string>>;
}

export function renderTypes(data: EventTypeData): string {
	const out = ['---@meta', ''];
	for (const [fn, byName] of [...data.handlers].sort(([a], [b]) => a.localeCompare(b))) {
		for (const [name, entry] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
			const params = entry.params.map((param, i) => (param === '...' ? '...: any' : `${IDENTIFIER.test(param) ? param : `p${i + 1}`}: ${entry.types[i] ?? 'any'}`));
			const filter = fn === 'on' || fn === 'once' ? ', filter?: any' : '';
			const result = fn === 'onCall' ? ': any' : '';
			out.push(`---@overload fun(name: ${literal(name)}, fn: fun(${params.join(', ')})${result}${filter})`);
		}
		out.push(`function lsmp.${fn}(${HANDLER_SIGNATURES[fn]}) end`, '');
	}
	for (const [fn, byName] of [...data.calls].sort(([a], [b]) => a.localeCompare(b))) {
		for (const [name, type] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
			const target = fn === 'callClient' ? 'playerId: integer, ' : '';
			out.push(`---@overload fun(${target}name: ${literal(name)}, ...: any): ${type.includes('|') ? `(${type})` : type}, string?`);
		}
		out.push(`function lsmp.${fn}(${CALL_SIGNATURES[fn]}) end`, '');
	}
	return out.join('\n');
}

interface FileCache {
	text: string;
	types: Map<string, string | undefined>;
}

export class EventTypes implements vscode.Disposable {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private lastOutput = '';
	private readonly cache = new Map<string, FileCache>();
	private returns: Record<string, string> = {};
	private returnsFrom = '';
	private readonly subscription: vscode.Disposable;

	constructor(
		private readonly index: EventIndex,
		private readonly library: () => string,
		private readonly typesFile: string,
		private readonly log: vscode.OutputChannel,
	) {
		this.subscription = index.onDidChange(() => this.schedule());
		try {
			this.lastOutput = fs.readFileSync(typesFile, 'utf8');
		} catch {
			this.lastOutput = '';
		}
		this.schedule();
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.run(), 400);
	}

	private async run(): Promise<void> {
		if (this.running) return this.schedule();
		this.running = true;
		try {
			const output = renderTypes(await this.compute());
			if (output !== this.lastOutput) {
				this.lastOutput = output;
				fs.mkdirSync(path.dirname(this.typesFile), { recursive: true });
				fs.writeFileSync(this.typesFile, output);
			}
		} catch (error) {
			this.log.appendLine(`event types: ${(error as Error).message}`);
		} finally {
			this.running = false;
		}
	}

	private file(uri: vscode.Uri, seen: Set<string>): FileCache {
		const key = uri.toString();
		let entry = this.cache.get(key);
		if (seen.has(key) && entry) return entry;
		seen.add(key);
		const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
		let text = '';
		try {
			text = open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8');
		} catch {
			text = '';
		}
		if (!entry || entry.text !== text) {
			entry = { text, types: new Map() };
			this.cache.set(key, entry);
		}
		return entry;
	}

	private async exprType(uri: vscode.Uri, span: Span, inferrer: Inferrer, seen: Set<string>): Promise<string | undefined> {
		const entry = this.file(uri, seen);
		const key = `${span.start}:${span.end}`;
		if (entry.types.has(key)) return entry.types.get(key);
		const { text } = entry;
		const expr = text.slice(span.start, span.end);
		const document = /\.lua$/i.test(uri.fsPath) ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : undefined;
		const hover = async (): Promise<string | undefined> => {
			if (!document || document.getText() !== text) return undefined;
			const at = expr.endsWith(')') ? span.start + matchingOpen(expr, expr.length - 1) - 1 : span.end - 1;
			return hoverType(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, document.positionAt(Math.max(span.start, at))));
		};
		let type = inferrer.infer(expr, text, span.start);
		if (isReference(expr) && (!type || type === 'table' || type.startsWith('{'))) type = (await hover()) ?? type;
		else if (!type) type = await hover();
		entry.types.set(key, type);
		return type;
	}

	private inferrer(): Inferrer {
		const library = this.library();
		if (library !== this.returnsFrom) {
			this.returnsFrom = library;
			try {
				this.returns = JSON.parse(fs.readFileSync(path.join(library, 'returns.json'), 'utf8')) as Record<string, string>;
			} catch {
				this.returns = {};
			}
		}
		return new Inferrer(this.returns);
	}

	private async compute(): Promise<EventTypeData> {
		const inferrer = this.inferrer();
		const seen = new Set<string>();
		const data: EventTypeData = { handlers: new Map(), calls: new Map() };
		const live = new Set<string>();
		for (const handler of this.index.all()) {
			if (handler.role !== 'handle' || !HANDLERS.has(handler.fn) || !handler.params.length || !/\.lua$/i.test(handler.uri.fsPath)) continue;
			live.add(handler.uri.toString());
			const byName = data.handlers.get(handler.fn) ?? new Map<string, HandlerTypes>();
			if (byName.has(handler.name)) continue;
			const emitters = this.index.counterparts(handler);
			if (!emitters.length) continue;
			const serverCall = handler.fn === 'onCall' && (handler.side === 'server' || (handler.side !== 'client' && emitters.some((e) => e.fn === 'callServer')));
			const hasSource = handler.fn === 'onClient' || serverCall;
			const types: (string | null)[] = [];
			if (hasSource) types.push(handler.fn === 'onClient' ? 'integer' : 'integer?');
			for (let i = 0; i < handler.params.length - (hasSource ? 1 : 0); i++) {
				if (handler.params[i + (hasSource ? 1 : 0)] === '...') break;
				const found = new Set<string>();
				let unknown = false;
				for (const emitter of emitters) {
					live.add(emitter.uri.toString());
					const span = emitter.args[i];
					const type = span ? await this.exprType(emitter.uri, span, inferrer, seen) : 'nil';
					if (type) found.add(type);
					else unknown = true;
				}
				types.push(!unknown && found.size ? unionOf(found) : null);
			}
			if (!types.some(Boolean)) continue;
			byName.set(handler.name, { params: handler.params, types });
			data.handlers.set(handler.fn, byName);
		}
		for (const caller of this.index.all()) {
			if (caller.role !== 'emit' || !CALLERS.has(caller.fn) || !/\.lua$/i.test(caller.uri.fsPath)) continue;
			const byName = data.calls.get(caller.fn) ?? new Map<string, string>();
			if (byName.has(caller.name)) continue;
			const handlers = this.index.counterparts(caller).filter((h) => h.fn === 'onCall');
			if (!handlers.length) continue;
			const found = new Set<string>();
			let unknown = false;
			for (const handler of handlers) {
				live.add(handler.uri.toString());
				if (!handler.returns.length) found.add('nil');
				for (const span of handler.returns) {
					const type = await this.exprType(handler.uri, span, inferrer, seen);
					if (type) found.add(type);
					else unknown = true;
				}
			}
			if (unknown || !found.size) continue;
			byName.set(caller.name, unionOf(found));
			data.calls.set(caller.fn, byName);
		}
		for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
		return data;
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.subscription.dispose();
		this.cache.clear();
	}
}
