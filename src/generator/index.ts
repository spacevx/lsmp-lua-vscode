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

export function generate(sdk: Sdk, natives: Natives, runtime: string, out: string): GenerateResult {
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(path.join(out, 'lsmp'), { recursive: true });
	fs.mkdirSync(path.join(out, 'natives'), { recursive: true });
	const stats = generateSdk(sdk, out, runtime);
	const nativeCount = generateNatives(natives, out);
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
