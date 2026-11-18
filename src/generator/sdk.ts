import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOCS, absLinks, comment, header, oneLine } from './markdown';
import { createTypeMapper, safeName, type TypeMapper } from './luatypes';
import { isFunction, isTable, type Sdk, type SdkBlock, type SdkCallout, type SdkFunction, type SdkParam, type SdkReturn } from './schema';

interface Located {
	f: SdkFunction;
	page: string;
}

interface Shape {
	headers: string[];
	rows: string[][];
	pendingFor?: SdkFunction;
}

interface EventEntry extends Located {
	name: string;
}

interface BrowserEventEntry extends EventEntry {
	cls: string;
}

const SOURCE = `${DOCS} (sdk.json)`;
const CLASS_OF: Record<string, string> = { browser: 'Browser', browser3d: 'Browser3D', cart: 'Cart', scene: 'Scene', pool: 'MysqlPool' };
const SIDE: Record<string, string> = { server: '**Server**', client: '**Client**', shared: '**Shared** (server & client)' };
const GENERIC_HEADERS = ['Field', 'Option', 'Key', 'Code', 'Name', 'Type', 'Event', 'Policy', 'Limit', 'Status', 'Setting'];
const CLASS_NAME = /^`?[A-Z][A-Za-z0-9]+`?$/;
const hasTypeColumn = (headers: string[]): boolean => headers.some((h) => /^Type$/i.test(h));

const docUrl = (f: SdkFunction, page: string): string => `${DOCS}#${page}${f.id ? '/' + f.id : ''}`;
const returnsOf = (f: SdkFunction): SdkReturn[] => (f.returns === undefined ? [] : Array.isArray(f.returns) ? f.returns : [f.returns]);
const pickLua = (f: SdkFunction): SdkReturn | undefined => {
	const all = returnsOf(f);
	return all.find((r) => r.only !== 'js') ?? all[0];
};
const luaParams = (f: SdkFunction): SdkParam[] => (f.params ?? []).filter((p) => p.only !== 'js');

const LITERAL_LIST = /^\s*(?:one of\s+|either\s+)?((?:`"[^"`]+"`(?:\s*\([^)]*\))?\s*(?:,|or|and|\/)?\s*)+)/i;

const PROSE_VALUES: Record<string, { values: string[]; list?: boolean }> = {
	ownerPolicy: { values: ['auto', 'pinned', 'server', 'frozen'] },
	lifePolicy: { values: ['whileRelevant', 'keep', 'withCreator'] },
	types: { values: ['vehicle', 'ped', 'object', 'playerPed'], list: true },
};

const INLINE_FIELD_TYPES: Record<string, string> = {
	maxRadius: 'number',
	radius: 'number',
	dimension: 'integer',
	heading: 'number',
	model: 'integer|string',
	transitionMs: 'integer',
	durationMs: 'integer',
	timeoutMs: 'integer',
	inherited: 'boolean',
	recursive: 'boolean',
	binary: 'boolean',
	pretty: 'boolean',
	water: 'boolean',
	append: 'boolean',
	exclusive: 'boolean',
	ignore: 'integer',
};

const enumValueSets = new Map<string, string>();

const valueKey = (values: string[]): string => [...values].sort().join('|');

function registerEnums(fns: { f: SdkFunction }[]): void {
	enumValueSets.clear();
	for (const { f } of fns) {
		if (!f.signature.lua || f.signature.lua.includes('(')) continue;
		const values = [...String(f.md ?? '').matchAll(/`lsmp\.[\w.]+\.\w+`\s*=\s*`"([^"]*)"`/g)].map((m) => m[1]);
		if (values.length >= 2 && !enumValueSets.has(valueKey(values))) enumValueSets.set(valueKey(values), f.name);
	}
}

function unionOf(values: string[]): string {
	const literals = values.map((v) => `"${v}"`).join('|');
	const enumName = enumValueSets.get(valueKey(values));
	return enumName ? `${enumName}|${literals}` : literals;
}

function literalType(type: string | undefined, desc: string | undefined, name?: string): string | null {
	const raw = String(type ?? '').replace(/`/g, '').trim();
	const prose = name ? PROSE_VALUES[name] : undefined;
	if (prose) {
		const union = unionOf(prose.values);
		return prose.list ? `(${union})[]` : union;
	}
	if (raw !== 'string' && raw !== 'string?') return null;
	const optional = raw.endsWith('?') ? '|nil' : '';
	if (/getTypes/.test(desc ?? '')) return `lsmp.WeatherType${optional}`;
	const list = LITERAL_LIST.exec(desc ?? '');
	if (!list) return null;
	const values = [...new Set([...list[1].matchAll(/`"([^"`]+)"`/g)].map((m) => m[1]).filter((v) => !/[<>{}\s]/.test(v)))];
	return values.length >= 2 ? unionOf(values) + optional : null;
}

const paramType = (type: string | undefined, desc: string | undefined, luaType: TypeMapper['luaType'], name?: string): string =>
	literalType(type, desc, name) ?? luaType(type);
const isLuaApi = (f: SdkFunction): boolean => f.side !== 'page' && (f.engines ?? []).includes('lua') && Boolean(f.signature.lua);

function collect(sdk: Sdk): { fns: Located[]; shapes: Map<string | symbol, Shape> } {
	const fns: Located[] = [];
	const shapes = new Map<string | symbol, Shape>();
	for (const section of sdk.sections) {
		for (const page of section.pages) {
			let lastHeading: string | null = null;
			let lastFn: SdkFunction | null = null;
			const visit = (blocks: SdkBlock[] | undefined): void => {
				for (const block of blocks ?? []) {
					if (!block || typeof block !== 'object') continue;
					if (block.type === 'heading') {
						lastHeading = block.text ?? null;
						continue;
					}
					if (isFunction(block)) {
						fns.push({ f: block, page: page.id });
						lastFn = block;
						lastHeading = null;
						for (const note of block.notes ?? []) {
							if (!isTable(note) || !hasTypeColumn(note.headers)) continue;
							const first = note.headers[0];
							if (/^[A-Z][A-Za-z0-9]+$/.test(first) && !/^(Field|Option)$/.test(first)) shapes.set(first, { headers: note.headers, rows: note.rows });
							else if (/^(Field|Option)$/i.test(first)) shapes.set(Symbol('pending'), { headers: note.headers, rows: note.rows, pendingFor: block });
						}
						continue;
					}
					if (isTable(block)) {
						const first = block.headers[0];
						if (/field$/i.test(first) && first !== 'Field' && lastHeading && CLASS_NAME.test(lastHeading)) {
							const name = lastHeading.replace(/`/g, '');
							const previous = shapes.get(name);
							if (previous) previous.rows = previous.rows.concat(block.rows);
							else shapes.set(name, { headers: block.headers, rows: block.rows });
							continue;
						}
						if ((first === 'Field' || first === 'Option') && lastHeading && CLASS_NAME.test(lastHeading)) {
							shapes.set(lastHeading.replace(/`/g, ''), { headers: block.headers, rows: block.rows });
						} else if (first === 'Option' && lastFn) {
							shapes.set(Symbol('pending'), { headers: block.headers, rows: block.rows, pendingFor: lastFn });
						} else if (/^[A-Z][A-Za-z0-9]+$/.test(first) && !GENERIC_HEADERS.includes(first) && hasTypeColumn(block.headers)) {
							shapes.set(first, { headers: block.headers, rows: block.rows });
						}
					}
					if (Array.isArray(block.blocks)) visit(block.blocks);
					if (Array.isArray(block.items)) visit(block.items.filter((item): item is SdkBlock => Boolean(item && typeof item === 'object' && 'type' in item)));
				}
			};
			visit(page.blocks);
		}
	}
	return { fns, shapes };
}

function docFor(f: SdkFunction, page: string): string {
	const lines = [`${SIDE[f.side ?? ''] ?? ''} · [Documentation](${docUrl(f, page)})`.replace(/^ · /, ''), '', `**${oneLine(f.summary)}**`];
	if (f.md) lines.push('', absLinks(f.md));
	for (const note of f.notes ?? []) {
		if (isTable(note) && note.rows) {
			lines.push('', `| ${note.headers.join(' | ')} |`, `| ${note.headers.map(() => '---').join(' | ')} |`, ...note.rows.map((row) => `| ${row.map(oneLine).join(' | ')} |`));
		} else if (note.type === 'callout') {
			const callout = note as SdkCallout;
			lines.push('', `> **${callout.title || 'Note'}**: ${oneLine(callout.md)}`);
		}
	}
	const tab = f.examples?.tabs?.find((t) => t.lang === 'lua');
	if (tab) lines.push('', '```lua', tab.code, '```');
	return comment(lines.join('\n'));
}

const HANDLER_TYPES: Record<string, string> = {
	'lsmp.onClient|server': 'fun(source: integer, ...: any)',
	'lsmp.onCall|shared': 'fun(source: integer?, ...: any): any',
	'lsmp.onServer|client': 'fun(...: any)',
	'lsmp.registerCommand|server': 'fun(args: string[], raw: string, source: integer?, invoker: string)',
	'lsmp.registerCommand|client': 'fun(args: string[], raw: string)',
};

function emitFunction(f: SdkFunction, page: string, declaration: string, { luaType, parseReturns }: TypeMapper): string {
	const out = [docFor(f, page)];
	const names: string[] = [];
	let vararg = false;
	for (const p of luaParams(f)) {
		const desc = oneLine(p.desc);
		if (p.name.startsWith('...')) {
			vararg = true;
			out.push(`---@param ... ${luaType(p.type)} ${desc}`);
			continue;
		}
		const name = safeName(p.name);
		names.push(name);
		const handler = p.name === 'fn' ? HANDLER_TYPES[`${f.name}|${f.side}`] : undefined;
		out.push(`---@param ${name}${p.optional ? '?' : ''} ${handler ?? paramType(p.type, p.desc, luaType, p.name)} ${desc}`);
	}
	const signature = f.signature.lua ?? '';
	if (/\bcb\b/.test(signature) && !names.includes('cb') && !vararg) {
		names.push('cb');
		out.push('---@param cb? function Callback `cb(result, err, details)`. Without it, call from a host coroutine (file body, event/RPC handler, lsmp.createThread): the call suspends.');
	}
	if (vararg) names.push('...');
	const ret = pickLua(f);
	const declared = (signature.split('-->')[1] ?? '').trim();
	parseReturns(declared && declared !== 'off' ? declared : ret?.type).forEach((r, i) =>
		out.push(`---@return ${r.type}${r.name ? ' ' + r.name : ''}${i === 0 && ret?.desc ? ' # ' + oneLine(ret.desc) : ''}`),
	);
	out.push(`function ${declaration}(${names.join(', ')}) end`);
	return out.join('\n');
}

const eventFn = (e: EventEntry, { luaType }: TypeMapper): string =>
	`fun(${luaParams(e.f)
		.map((p) => `${safeName(p.name.replace(/^\.\.\./, 'args'))}: ${paramType(p.type, p.desc, luaType, p.name)}`)
		.join(', ')})`;

function insertOverloads(blocks: string[], declaration: string, overloads: string[]): void {
	const index = blocks.findIndex((block) => block.includes(`function ${declaration}(`));
	if (index < 0) return;
	const at = blocks[index].indexOf('---@param');
	blocks[index] = blocks[index].slice(0, at) + overloads.join('\n') + '\n' + blocks[index].slice(at);
}

export interface SdkStats {
	functions: number;
	methods: number;
	enums: number;
	events: number;
	classes: number;
}

export function generateSdk(sdk: Sdk, out: string, staticRuntime: string): SdkStats {
	const types = createTypeMapper();
	const { luaType, referenced } = types;
	const { fns, shapes } = collect(sdk);
	registerEnums(fns);
	const core: string[] = [];
	const classes: string[] = [];
	const enums: string[] = [];
	const globals: string[] = [];
	const tables = new Set(['lsmp']);
	const events: EventEntry[] = [];
	const browserEvents: BrowserEventEntry[] = [];
	const enumNames = new Set<string>();

	for (const { f, page } of fns) {
		if (!isLuaApi(f)) continue;
		const signature = f.signature.lua as string;
		const event = /^lsmp\.on\("([^"]+)"/.exec(signature);
		if (event) {
			events.push({ name: event[1], f, page });
			continue;
		}
		const browserEvent = /^browser(3d)?:on\("([^"]+)"/.exec(signature);
		if (browserEvent) {
			browserEvents.push({ cls: browserEvent[1] ? 'Browser3D' : 'Browser', name: browserEvent[2], f, page });
			continue;
		}
		if (!signature.includes('(')) {
			const pairs = [...String(f.md ?? '').matchAll(/`(lsmp\.[\w.]+)\.(\w+)`\s*=\s*`?("[^"]*"|-?\d+)`?/g)];
			if (pairs.length && !enumNames.has(f.name)) {
				enumNames.add(f.name);
				enums.push(`${docFor(f, page)}\n---@enum ${f.name}\n${f.name} = {\n${pairs.map(([, , key, value]) => `    ${key} = ${value},`).join('\n')}\n}`);
			} else if (!pairs.length) {
				core.push(`${docFor(f, page)}\n---@type ${luaType(pickLua(f)?.type)}\n${f.name} = nil`);
			}
			continue;
		}
		const [prefix, ...rest] = f.name.split('.');
		if (CLASS_OF[prefix]) {
			classes.push(emitFunction(f, page, `${CLASS_OF[prefix]}:${rest.join('.')}`, types));
		} else if (prefix === 'lsmp') {
			const segments = f.name.split('.');
			for (let i = 2; i < segments.length; i++) tables.add(segments.slice(0, i).join('.'));
			core.push(emitFunction(f, page, f.name, types));
		} else {
			globals.push(emitFunction(f, page, f.name, types));
		}
	}

	const eventOverloads = events.map((e) => `---@overload fun(name: "${e.name}", fn: ${eventFn(e, types)}${e.name === 'metaChange' ? ', filter?: MetaFilter' : ''}): (fun(): boolean)`);
	insertOverloads(core, 'lsmp.on', eventOverloads);
	insertOverloads(core, 'lsmp.once', eventOverloads);

	const byClass = new Map<string, string[]>();
	for (const e of browserEvents) {
		const list = byClass.get(e.cls) ?? [];
		list.push(`---@overload fun(self: ${e.cls}, event: "${e.name}", fn: ${eventFn(e, types)}): (fun(): boolean)`);
		byClass.set(e.cls, list);
	}
	for (const [cls, overloads] of byClass) insertOverloads(classes, `${cls}:on`, overloads);

	const eventNames = [...new Set(events.map((e) => e.name))].sort();
	const eventLines = [
		'---@meta',
		'',
		'-- Engine events (lsmp.on / lsmp.once). Generated from the official SDK.',
		'',
		'---@alias lsmp.EngineEvent',
		...eventNames.map((name) => {
			const e = events.find((x) => x.name === name) as EventEntry;
			return `---| "${name}" # ${SIDE[e.f.side ?? ''] ?? ''} ${oneLine(e.f.summary)}`;
		}),
		'',
		...events.map((e) => `-- ${e.name} (${e.f.side}): ${oneLine(e.f.summary)}`),
	];

	const classDefs: string[] = [];
	const outputTypes = new Set<string>();
	for (const { f } of fns) for (const r of returnsOf(f)) for (const m of String(r.type ?? '').matchAll(/[A-Z][A-Za-z0-9]+/g)) outputTypes.add(m[0]);
	const defined = new Set(Object.values(CLASS_OF));

	for (const [key, shape] of shapes) {
		let name: string;
		if (typeof key === 'string') name = key;
		else {
			const options = (shape.pendingFor?.params ?? []).find((p) => /^[A-Z]\w*Options$/.test(String(p.type).replace(/[`?]/g, '')));
			if (!options) continue;
			name = String(options.type).replace(/[`?]/g, '');
		}
		if (defined.has(name)) continue;
		defined.add(name);
		const iType = shape.headers.findIndex((h) => /^Type$/i.test(h));
		const iDefault = shape.headers.findIndex((h) => /^Default$/i.test(h));
		const iDesc = shape.headers.length - 1;
		const lines = [`---@class ${name}`];
		for (const row of shape.rows) {
			const field = String(row[0]).replace(/[`*]/g, '').trim();
			if (!/^[A-Za-z_]\w*$/.test(field)) continue;
			const def = iDefault >= 0 ? String(row[iDefault]).replace(/`/g, '').trim() : '';
			const optional = !outputTypes.has(name) || /Options$/.test(name) || (iDefault >= 0 && def !== '—' && def !== '-' && def !== '') || /^opt/i.test(def);
			const desc = oneLine(row[iDesc]) + (def && def !== '—' ? ` Default: \`${def}\`.` : '');
			lines.push(`---@field ${field}${optional ? '?' : ''} ${iType >= 0 ? paramType(row[iType], row[iDesc], luaType, field) : 'any'} ${desc}`);
		}
		classDefs.push(lines.join('\n'));
	}

	for (const m of staticRuntime.matchAll(/---@(?:class|alias) ([\w.]+)/g)) defined.add(m[1]);

	const inline = new Map<string, { fields: string[]; desc: string }>();
	for (const { f } of fns) {
		for (const item of [...(f.params ?? []), ...returnsOf(f)]) {
			const type = String(item.type ?? '').replace(/[`?{}]|, err/g, '').trim();
			if (!/^[A-Z][A-Za-z0-9]+$/.test(type) || defined.has(type)) continue;
			const braces = /`\{([^`}]*)\}`/.exec(String(item.desc ?? ''));
			if (!braces) continue;
			const fields = [...braces[1].matchAll(/([A-Za-z_]\w*)\s*(?==|,|$)/g)].map((m) => m[1]);
			if (!fields.length) continue;
			const known = inline.get(type);
			if (known) known.fields.push(...fields);
			else inline.set(type, { fields, desc: oneLine(item.desc) });
		}
	}
	for (const [type, shape] of inline) {
		defined.add(type);
		classDefs.push([`---${shape.desc}`, `---@class ${type}`, ...[...new Set(shape.fields)].map((field) => `---@field ${field}? ${literalType(undefined, undefined, field) ?? INLINE_FIELD_TYPES[field] ?? 'any'}`)].join('\n'));
	}

	for (const e of enumNames) {
		const short = e.split('.').pop() as string;
		if (referenced.has(short) && !defined.has(short)) {
			defined.add(short);
			classDefs.push(`---@alias ${short} ${e}`);
		}
	}
	for (const type of [...referenced].sort()) {
		if (defined.has(type) || type === 'Vector3') continue;
		defined.add(type);
		classDefs.push(`---@class ${type}\n---@field [string] any`);
	}

	const tableDecls = [...tables]
		.sort((a, b) => a.split('.').length - b.split('.').length)
		.map((t) =>
			t === 'lsmp'
				? '---The LS:MP scripting API. Same functions in Lua and JavaScript, on the server and on the client.\n---@class lsmp\nlsmp = {}'
				: `---@class ${t}\n${t} = {}`,
		);
	const dir = path.join(out, 'lsmp');
	fs.writeFileSync(path.join(dir, 'api.lua'), [header('lsmp API', SOURCE), ...tableDecls, '', ...core].join('\n\n') + '\n');
	fs.writeFileSync(
		path.join(dir, 'classes.lua'),
		[header('Objects returned by the API', SOURCE), Object.values(CLASS_OF).map((c) => `---@class ${c}\nlocal ${c} = {}`).join('\n\n'), ...classes, ...classDefs].join('\n\n') + '\n',
	);
	fs.writeFileSync(path.join(dir, 'enums.lua'), [header('Enums and constants', SOURCE), ...enums].join('\n\n') + '\n');
	fs.writeFileSync(path.join(dir, 'events.lua'), eventLines.join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'globals.lua'), [header('Global functions (timers)', SOURCE), ...globals].join('\n\n') + '\n');
	fs.writeFileSync(path.join(dir, 'runtime.lua'), staticRuntime);

	const apiIndex = fns
		.filter(({ f }) => isLuaApi(f))
		.map(({ f, page }) => ({ name: f.name, side: f.side, sig: f.signature.lua, summary: oneLine(f.summary).replace(/\*\*/g, ''), url: docUrl(f, page) }));
	fs.writeFileSync(path.join(out, 'api.json'), JSON.stringify(apiIndex));

	return { functions: core.length, methods: classes.length, enums: enums.length, events: events.length, classes: classDefs.length };
}
