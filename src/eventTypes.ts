import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EventIndex, Span, Use } from './events';

type TypeMap = Record<string, Record<string, (string | null)[]>>;

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

export class EventTypes implements vscode.Disposable {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private lastJson = '';
	private readonly subscription: vscode.Disposable;

	constructor(
		private readonly index: EventIndex,
		private readonly library: () => string,
		private readonly typesFile: string,
		private readonly onChange: () => Promise<void>,
		private readonly log: vscode.OutputChannel,
	) {
		this.subscription = index.onDidChange(() => this.schedule());
		try {
			this.lastJson = fs.readFileSync(typesFile, 'utf8');
		} catch {
			this.lastJson = '';
		}
		this.schedule();
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.run(), 1500);
	}

	private async run(): Promise<void> {
		if (this.running) return this.schedule();
		this.running = true;
		try {
			const json = JSON.stringify({ files: await this.compute() });
			if (json !== this.lastJson) {
				this.lastJson = json;
				fs.mkdirSync(path.dirname(this.typesFile), { recursive: true });
				fs.writeFileSync(this.typesFile, json);
				await this.onChange();
			}
		} catch (error) {
			this.log.appendLine(`event types: ${(error as Error).message}`);
		} finally {
			this.running = false;
		}
	}

	private text(uri: vscode.Uri, cache: Map<string, string>): string {
		const key = uri.toString();
		let text = cache.get(key);
		if (text === undefined) {
			const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
			try {
				text = open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8');
			} catch {
				text = '';
			}
			cache.set(key, text);
		}
		return text;
	}

	private async argType(emitter: Use, index: number, inferrer: Inferrer, cache: Map<string, string>): Promise<string | undefined> {
		const span = emitter.args[index];
		return span ? this.exprType(emitter.uri, span, inferrer, cache) : 'nil';
	}

	private async exprType(uri: vscode.Uri, span: Span, inferrer: Inferrer, cache: Map<string, string>): Promise<string | undefined> {
		const text = this.text(uri, cache);
		const expr = text.slice(span.start, span.end);
		const lua = /\.lua$/i.test(uri.fsPath);
		const hover = async (): Promise<string | undefined> => {
			if (!lua) return undefined;
			const document = await vscode.workspace.openTextDocument(uri);
			const at = expr.endsWith(')') ? span.start + matchingOpen(expr, expr.length - 1) - 1 : span.end - 1;
			return hoverType(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, document.positionAt(Math.max(span.start, at))));
		};
		if (isReference(expr)) {
			const fromLuaLS = await hover();
			if (fromLuaLS && fromLuaLS !== 'table') return fromLuaLS;
		}
		return inferrer.infer(expr, text, span.start) ?? (await hover());
	}

	private async compute(): Promise<TypeMap> {
		let returns: Record<string, string> = {};
		try {
			returns = JSON.parse(fs.readFileSync(path.join(this.library(), 'returns.json'), 'utf8')) as Record<string, string>;
		} catch {
			returns = {};
		}
		const inferrer = new Inferrer(returns);
		const cache = new Map<string, string>();
		const map: TypeMap = {};
		for (const handler of this.index.all()) {
			if (handler.role !== 'handle' || !HANDLERS.has(handler.fn) || !handler.params.length || !/\.lua$/i.test(handler.uri.fsPath)) continue;
			const emitters = this.index.counterparts(handler).filter((e) => e.args !== undefined);
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
					const type = await this.argType(emitter, i, inferrer, cache);
					if (type) found.add(type);
					else unknown = true;
				}
				types.push(!unknown && found.size ? [...found].join('|') : null);
			}
			if (!types.some(Boolean)) continue;
			const file = handler.uri.toString().toLowerCase();
			(map[file] ??= {})[`${handler.fn}|${handler.name}`] = types;
		}
		for (const caller of this.index.all()) {
			if (caller.role !== 'emit' || !CALLERS.has(caller.fn) || !/.lua$/i.test(caller.uri.fsPath)) continue;
			const handlers = this.index.counterparts(caller).filter((h) => h.fn === 'onCall' && h.returns);
			if (!handlers.length) continue;
			const found = new Set<string>();
			let unknown = false;
			for (const handler of handlers) {
				if (!handler.returns.length) found.add('nil');
				for (const span of handler.returns) {
					const type = await this.exprType(handler.uri, span, inferrer, cache);
					if (type) found.add(type);
					else unknown = true;
				}
			}
			if (unknown || !found.size) continue;
			const file = caller.uri.toString().toLowerCase();
			(map[file] ??= {})[`call|${caller.name}`] = [unionOf(found)];
		}
		return map;
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.subscription.dispose();
	}
}
