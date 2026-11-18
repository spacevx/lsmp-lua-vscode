import type { Natives, Sdk, SdkBlock, SdkFunction, SdkParam, SdkReturn } from './generator/schema';
import { isFunction } from './generator/schema';

export interface FunctionSnapshot {
	sig: string;
	summary: string;
	params: string;
	returns: string;
}

export interface Snapshot {
	functions: Record<string, FunctionSnapshot>;
	natives: Record<string, [namespace: string, signature: string, blocked: string]>;
	pages: string[];
}

export interface FunctionChange {
	name: string;
	side: string;
	before?: FunctionSnapshot;
	after?: FunctionSnapshot;
}

export interface NativeChange {
	name: string;
	namespace: string;
	before?: string;
	after?: string;
	blockedBefore?: string;
	blockedAfter?: string;
}

export interface Changes {
	functions: { added: FunctionChange[]; removed: FunctionChange[]; changed: FunctionChange[] };
	natives: { added: NativeChange[]; removed: NativeChange[]; changed: NativeChange[]; blocked: NativeChange[]; unblocked: NativeChange[] };
	pages: { added: string[]; removed: string[] };
}

export interface ChangeEntry {
	date: number;
	from: string;
	to: string;
	changes: Changes;
}

const LIST_LIMIT = 150;

const paramsOf = (params: SdkParam[] | undefined): string =>
	(params ?? []).filter((p) => p.only !== 'js').map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');

const returnsOf = (returns: SdkReturn | SdkReturn[] | undefined): string =>
	(Array.isArray(returns) ? returns : returns ? [returns] : []).filter((r) => r.only !== 'js').map((r) => r.type).join(', ');

export function snapshot(sdk: Sdk, natives: Natives): Snapshot {
	const result: Snapshot = { functions: {}, natives: {}, pages: [] };
	const visit = (blocks: SdkBlock[] | undefined): void => {
		for (const block of blocks ?? []) {
			if (!block || typeof block !== 'object') continue;
			if (isFunction(block)) {
				const fn = block as SdkFunction;
				result.functions[`${fn.name}|${fn.side ?? 'shared'}`] = {
					sig: fn.signature.lua ?? fn.signature.js ?? fn.name,
					summary: fn.summary ?? '',
					params: paramsOf(fn.params),
					returns: returnsOf(fn.returns),
				};
			}
			if (Array.isArray(block.blocks)) visit(block.blocks);
		}
	};
	for (const section of sdk.sections) {
		for (const page of section.pages) {
			result.pages.push(`${section.title} / ${page.title}`);
			visit(page.blocks);
		}
	}
	for (const namespace of natives.namespaces) {
		for (const n of namespace.natives) {
			const params = (n.params ?? []).map(([name, type]) => `${name}: ${type}`).join(', ');
			const outs = (n.outs ?? []).map(([name, type]) => `${name}: ${type}`);
			const returns = [n.ret, ...outs].filter(Boolean).join(', ') || 'void';
			result.natives[n.name] = [namespace.id, `${n.name}(${params}) -> ${returns}`, n.blocked ?? ''];
		}
	}
	return result;
}

export function diff(before: Snapshot, after: Snapshot): Changes {
	const changes: Changes = {
		functions: { added: [], removed: [], changed: [] },
		natives: { added: [], removed: [], changed: [], blocked: [], unblocked: [] },
		pages: { added: after.pages.filter((p) => !before.pages.includes(p)), removed: before.pages.filter((p) => !after.pages.includes(p)) },
	};
	const split = (key: string): { name: string; side: string } => {
		const at = key.lastIndexOf('|');
		return { name: key.slice(0, at), side: key.slice(at + 1) };
	};
	for (const [key, fn] of Object.entries(after.functions)) {
		const old = before.functions[key];
		if (!old) changes.functions.added.push({ ...split(key), after: fn });
		else if (old.sig !== fn.sig || old.params !== fn.params || old.returns !== fn.returns || old.summary !== fn.summary) {
			changes.functions.changed.push({ ...split(key), before: old, after: fn });
		}
	}
	for (const [key, fn] of Object.entries(before.functions)) {
		if (!after.functions[key]) changes.functions.removed.push({ ...split(key), before: fn });
	}
	for (const [name, [namespace, sig, blocked]] of Object.entries(after.natives)) {
		const old = before.natives[name];
		if (!old) {
			changes.natives.added.push({ name, namespace, after: sig, blockedAfter: blocked });
			continue;
		}
		if (old[1] !== sig) changes.natives.changed.push({ name, namespace, before: old[1], after: sig });
		if (!old[2] && blocked) changes.natives.blocked.push({ name, namespace, blockedAfter: blocked });
		else if (old[2] && !blocked) changes.natives.unblocked.push({ name, namespace, blockedBefore: old[2] });
	}
	for (const [name, [namespace, sig]] of Object.entries(before.natives)) {
		if (!after.natives[name]) changes.natives.removed.push({ name, namespace, before: sig });
	}
	for (const list of [...Object.values(changes.functions), ...Object.values(changes.natives)]) {
		(list as { name: string }[]).sort((a, b) => a.name.localeCompare(b.name));
	}
	return changes;
}

const plural = (count: number, word: string): string => `${count} ${word}${count > 1 ? 's' : ''}`;

export function summarize(changes: Changes): string {
	const { functions: f, natives: n, pages: p } = changes;
	const parts = [
		f.added.length && `+${plural(f.added.length, 'function')}`,
		f.removed.length && `−${plural(f.removed.length, 'function')}`,
		f.changed.length && `${plural(f.changed.length, 'function')} changed`,
		n.added.length && `+${plural(n.added.length, 'native')}`,
		n.removed.length && `−${plural(n.removed.length, 'native')}`,
		n.changed.length && `${plural(n.changed.length, 'native')} changed`,
		n.blocked.length && `${n.blocked.length} newly blocked`,
		n.unblocked.length && `${n.unblocked.length} unblocked`,
		p.added.length && `+${plural(p.added.length, 'page')}`,
		p.removed.length && `−${plural(p.removed.length, 'page')}`,
	].filter(Boolean);
	return parts.length ? parts.join(', ') : 'documentation changes only';
}

export const isEmpty = (changes: Changes): boolean => summarize(changes) === 'documentation changes only';

function list<T>(title: string, items: T[], line: (item: T) => string[]): string[] {
	if (!items.length) return [];
	const out = [`#### ${title} (${items.length})`, ''];
	for (const item of items.slice(0, LIST_LIMIT)) out.push(...line(item));
	if (items.length > LIST_LIMIT) out.push(`- …and ${items.length - LIST_LIMIT} more`);
	out.push('');
	return out;
}

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

function renderFunction(change: FunctionChange): string[] {
	const head = `- ${code(change.name)} *${change.side}*`;
	if (!change.before && change.after) return [`${head}: ${code(change.after.sig)}${change.after.summary ? `<br>${change.after.summary}` : ''}`];
	if (change.before && !change.after) return [`${head}: ${code(change.before.sig)}`];
	const before = change.before as FunctionSnapshot;
	const after = change.after as FunctionSnapshot;
	const lines = [head];
	if (before.sig !== after.sig) lines.push(`  - signature: ${code(before.sig)} → ${code(after.sig)}`);
	if (before.params !== after.params) lines.push(`  - parameters: ${code(before.params || 'none')} → ${code(after.params || 'none')}`);
	if (before.returns !== after.returns) lines.push(`  - returns: ${code(before.returns || 'nothing')} → ${code(after.returns || 'nothing')}`);
	if (before.summary !== after.summary) lines.push(`  - summary: ${after.summary || '*removed*'}`);
	return lines;
}

export function render(entries: ChangeEntry[]): string {
	const out = ['# LS:MP: What\'s changed', ''];
	if (!entries.length) {
		out.push('No update from lsmp.gg recorded yet. Changes appear here after the definitions update.');
		return out.join('\n');
	}
	for (const entry of entries) {
		const { functions: f, natives: n, pages: p } = entry.changes;
		out.push(`## ${new Date(entry.date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`, '', `**${summarize(entry.changes)}**`, '');
		if (f.added.length || f.removed.length || f.changed.length) {
			out.push('### SDK', '');
			out.push(...list('Added', f.added, renderFunction));
			out.push(...list('Removed', f.removed, renderFunction));
			out.push(...list('Changed', f.changed, renderFunction));
		}
		if (p.added.length || p.removed.length) {
			out.push('### Pages', '');
			out.push(...list('Added', p.added, (page) => [`- ${page}`]));
			out.push(...list('Removed', p.removed, (page) => [`- ${page}`]));
		}
		if (Object.values(n).some((items) => items.length)) {
			out.push('### Natives', '');
			out.push(...list('Added', n.added, (c) => [`- ${code(c.after as string)} *${c.namespace}*${c.blockedAfter ? ` (blocked: ${c.blockedAfter})` : ''}`]));
			out.push(...list('Removed', n.removed, (c) => [`- ${code(c.before as string)} *${c.namespace}*`]));
			out.push(...list('Signature changed', n.changed, (c) => [`- ${code(c.before as string)} → ${code(c.after as string)}`]));
			out.push(...list('Newly blocked', n.blocked, (c) => [`- ${code(c.name)} *${c.namespace}* (${c.blockedAfter})`]));
			out.push(...list('Unblocked', n.unblocked, (c) => [`- ${code(c.name)} *${c.namespace}* (was ${c.blockedBefore})`]));
		}
		out.push('---', '');
	}
	return out.join('\n');
}
