import * as fs from 'node:fs';
import * as path from 'node:path';
import { comment, header, oneLine } from './markdown';
import { safeName } from './luatypes';
import type { Native, Natives } from './schema';

const SOURCE = 'https://lsmp.gg/resources/natives.json';
const LUA_BASE: Record<string, string> = { integer: 'integer', number: 'number', boolean: 'boolean', string: 'string', Vector3: 'Vector3' };

export function generateNatives(natives: Natives, out: string): number {
	const types = natives.types;
	const policy = natives.meta.policy;
	const dir = path.join(out, 'natives');

	const nativeType = (type: string): string => {
		const known = types[type];
		if (!known) return 'any';
		return known.alias ? type : (LUA_BASE[known.lua] ?? 'any');
	};

	const aliases = [header('Native types (handles are game handles, not netIds)', SOURCE)];
	for (const [name, type] of Object.entries(types)) {
		if (type.alias) aliases.push(`---${oneLine(type.doc)}\n---@alias ${name} ${type.lua === 'integer' || type.lua === 'number' ? type.lua : 'any'}`);
	}
	fs.writeFileSync(path.join(dir, '_types.lua'), aliases.join('\n\n') + '\n');

	const vectorOverload = (n: Native, names: string[]): string | null => {
		const params = n.params ?? [];
		const parts: string[] = [];
		let found = false;
		for (let i = 0; i < params.length; i++) {
			const triple = params.slice(i, i + 3);
			const axes = triple.map(([name, type]) => (type === 'float' ? /^(.*?)([XYZxyz])(\d*)$/.exec(name) : null));
			const isTriple =
				axes.length === 3 &&
				axes.every((m) => m !== null) &&
				axes.map((m) => (m as RegExpExecArray)[2].toLowerCase()).join('') === 'xyz' &&
				new Set(axes.map((m) => `${(m as RegExpExecArray)[1]}|${(m as RegExpExecArray)[3]}`)).size === 1;
			if (isTriple) {
				const [, prefix, , suffix] = axes[0] as RegExpExecArray;
				const base = safeName(`${prefix.replace(/_$/, '') || 'pos'}${suffix}`);
				parts.push(`${names.includes(base) ? `${base}Vec` : base}: lsmp.Vec3Like`);
				found = true;
				i += 2;
			} else {
				parts.push(`${names[i]}: ${nativeType(params[i][1])}`);
			}
		}
		return found ? parts.join(', ') : null;
	};

	const declare = (namespace: string, n: Native): string => {
		const doc = [`**\`${namespace}\` \`client\`** · \`${n.native}\` · \`${n.hash}\` · [natives](https://lsmp.gg/resources/natives)`];
		if (n.blocked) doc.push('', `⛔ **Blocked by LS:MP** (${policy.categories[n.blocked]?.title ?? n.blocked}): calling it raises \`${policy.error}\`.`);
		if (n.na) doc.push('', '⚠ Not in the current game build: calling it does nothing.');
		for (const note of n.notes ?? []) if (!note.lang || note.lang === 'lua') doc.push('', `**${note.title}**: ${oneLine(note.md)}`);
		if (n.since) doc.push('', `Since build ${n.since}.`);
		if (n.aka) doc.push('', `Previously: ${n.aka.join(', ')}.`);
		if (n.doc) doc.push('', n.doc);

		const lines = [comment(doc.join('\n'))];
		if (n.blocked || n.na) lines.push(`---@deprecated ${n.blocked ? `Blocked by LS:MP: ${policy.error}` : 'Not in the current game build'}`);
		const names: string[] = [];
		for (const [rawName, type, desc] of n.params ?? []) {
			let name = safeName(rawName);
			while (names.includes(name)) name += '_';
			names.push(name);
			lines.push(`---@param ${name} ${nativeType(type)}${desc ? ' ' + oneLine(desc) : ''}`);
		}
		const returns = [...(n.ret ? [nativeType(n.ret)] : []), ...(n.outs ?? []).map(([, type]) => nativeType(type))];
		const vectorForm = vectorOverload(n, names);
		if (vectorForm) lines.push(`---@overload fun(${vectorForm})${returns.length ? ': ' + returns.join(', ') : ''}`);
		if (n.ret) lines.push(`---@return ${nativeType(n.ret)}`);
		for (const [name, type, , desc] of n.outs ?? []) lines.push(`---@return ${nativeType(type)} ${safeName(name)}${desc ? ' # ' + oneLine(desc) : ''}`);
		lines.push(`function ${n.name}(${names.join(', ')}) end`);
		return lines.join('\n');
	};

	let count = 0;
	for (const namespace of natives.namespaces) {
		const blocks = [header(`${namespace.id}: ${namespace.title}. ${oneLine(namespace.doc)}`, SOURCE), ...namespace.natives.map((n) => declare(namespace.id, n))];
		count += namespace.natives.length;
		fs.writeFileSync(path.join(dir, `${namespace.id}.lua`), blocks.join('\n\n') + '\n');
	}
	return count;
}
