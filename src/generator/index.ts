import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateNatives } from './natives';
import { generateSdk, type SdkStats } from './sdk';
import type { Natives, Sdk } from './schema';

export type { Natives, Sdk } from './schema';

export interface GenerateResult extends SdkStats {
	natives: number;
	namespaces: number;
	stamp: string;
}

function stampOf(dir: string): string {
	const hash = createHash('sha256');
	const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
	for (const file of files) {
		const full = path.join(dir, file);
		if (fs.statSync(full).isFile()) hash.update(file.replace(/\\/g, '/')).update(fs.readFileSync(full));
	}
	return hash.digest('hex').slice(0, 12);
}

export interface Sides {
	api: Record<string, string[]>;
	events: Record<string, string[]>;
	natives: string[];
}

function writeSides(natives: Natives, out: string): void {
	const api = JSON.parse(fs.readFileSync(path.join(out, 'api.json'), 'utf8')) as { name: string; side: string; sig: string }[];
	const sides: Sides = { api: {}, events: {}, natives: [] };
	const add = (map: Record<string, string[]>, name: string, side: string): void => {
		const list = (map[name] ??= []);
		if (!list.includes(side)) list.push(side);
	};
	for (const entry of api) {
		const event = /^lsmp\.on\("([^"]+)"/.exec(entry.sig ?? '');
		if (event) add(sides.events, event[1], entry.side);
		else if (entry.name.startsWith('lsmp.')) add(sides.api, entry.name, entry.side);
	}
	for (const namespace of natives.namespaces) for (const n of namespace.natives) sides.natives.push(n.name);
	sides.natives.sort();
	fs.writeFileSync(path.join(out, 'sides.json'), JSON.stringify(sides));
}

function writeReturns(natives: Natives, out: string): void {
	const returns: Record<string, string> = { Vector2: 'vector2', Vector3: 'vector3', Vector4: 'vector4', Quaternion: 'quaternion' };
	const api = fs.readFileSync(path.join(out, 'lsmp', 'api.lua'), 'utf8').split('\n');
	let first: string | undefined;
	for (const line of api) {
		const ret = /^---@return ([^\s#]+)/.exec(line);
		if (ret && first === undefined) first = ret[1];
		const fn = /^function (lsmp\.[\w.]+)\(/.exec(line);
		if (fn) {
			if (first && first !== 'any' && !returns[fn[1]]) returns[fn[1]] = first;
			first = undefined;
		} else if (!line.startsWith('---')) first = undefined;
	}
	const types = natives.types;
	const nativeType = (t: string): string | undefined => {
		const known = types[t];
		if (!known) return undefined;
		if (known.lua === 'Vector3') return 'vector3';
		return ['integer', 'number', 'boolean', 'string'].includes(known.lua) ? known.lua : undefined;
	};
	for (const namespace of natives.namespaces) {
		for (const n of namespace.natives) {
			const type = n.ret ? nativeType(n.ret) : n.outs?.[0] ? nativeType(n.outs[0][1]) : undefined;
			if (type) returns[n.name] = type;
		}
	}
	fs.writeFileSync(path.join(out, 'returns.json'), JSON.stringify(returns));
}

export function generate(sdk: Sdk, natives: Natives, runtime: string, out: string): GenerateResult {
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(path.join(out, 'lsmp'), { recursive: true });
	fs.mkdirSync(path.join(out, 'natives'), { recursive: true });
	const stats = generateSdk(sdk, out, runtime);
	const nativeCount = generateNatives(natives, out);
	writeSides(natives, out);
	writeReturns(natives, out);
	const stamp = stampOf(out);
	fs.writeFileSync(path.join(out, 'stamp'), stamp);
	return { ...stats, natives: nativeCount, namespaces: natives.namespaces.length, stamp };
}

export function parseSdk(text: string): Sdk {
	const sdk = JSON.parse(text) as Sdk;
	if (!Array.isArray(sdk?.sections) || !sdk.sections.every((s) => Array.isArray(s.pages))) throw new Error('sdk.json: unexpected format');
	return sdk;
}

export function parseNatives(text: string): Natives {
	const natives = JSON.parse(text) as Natives;
	if (!Array.isArray(natives?.namespaces) || typeof natives.types !== 'object' || !natives.meta?.policy) throw new Error('natives.json: unexpected format');
	return natives;
}
