import * as fs from 'node:fs';
import * as path from 'node:path';
import { generate, parseNatives, parseSdk } from './generator';
import { SOURCES, fetchSource } from './sources';

const root = path.join(__dirname, '..');
const data = path.join(root, 'data');

async function fetchAll(): Promise<void> {
	fs.mkdirSync(data, { recursive: true });
	for (const [name, url] of Object.entries(SOURCES)) {
		const result = await fetchSource(url);
		if (!result.changed) continue;
		(name === 'sdk' ? parseSdk : parseNatives)(result.text);
		fs.writeFileSync(path.join(data, `${name}.json`), result.text);
		console.log(`${name}.json: ${result.text.length} bytes`);
	}
}

function generateAll(): void {
	const read = (file: string): string => fs.readFileSync(path.join(data, file), 'utf8');
	const runtime = fs.readFileSync(path.join(root, 'library-static', 'runtime.lua'), 'utf8');
	const result = generate(parseSdk(read('sdk.json')), parseNatives(read('natives.json')), runtime, path.join(root, 'library'));
	console.log(`lsmp: ${result.functions} functions, ${result.methods} methods, ${result.enums} enums, ${result.events} engine events, ${result.classes} classes`);
	console.log(`natives: ${result.natives} in ${result.namespaces} namespaces`);
	console.log(`stamp: ${result.stamp}`);
}

const command = process.argv[2];
if (command === 'fetch') {
	fetchAll().catch((error: Error) => {
		console.error(error.message);
		process.exit(1);
	});
} else if (command === 'generate') {
	generateAll();
} else {
	console.error('usage: node dist/cli.js fetch|generate');
	process.exit(1);
}
