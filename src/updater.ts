import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { diff, summarize, type ChangeEntry, type Snapshot } from './changes';
import { generate, parseNatives, parseSdk } from './generator';
import { SOURCES, fetchSource, type SourceName, type Validator } from './sources';

const KEEP_LIBRARIES = 2;
const HISTORY = 30;

interface State {
	stamp?: string;
	extensionVersion?: string;
	checkedAt?: number;
	validators?: Partial<Record<SourceName, Validator>>;
}

export type UpdateOutcome =
	| { status: 'unchanged' }
	| { status: 'updated'; library: string; summary: string }
	| { status: 'failed'; error: string };

const exists = (file: string): boolean => fs.existsSync(file);
const readText = (file: string): string => fs.readFileSync(file, 'utf8');

export class Definitions {
	private readonly storage: string;
	private readonly remote: string;
	private readonly stateFile: string;
	private readonly historyFile: string;
	private readonly bundled: string;
	private readonly runtimeFile: string;
	private readonly version: string;
	private running: Promise<UpdateOutcome> | undefined;

	constructor(context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
		this.storage = context.globalStorageUri.fsPath;
		this.remote = path.join(this.storage, 'remote');
		this.stateFile = path.join(this.storage, 'state.json');
		this.historyFile = path.join(this.storage, 'changes.json');
		this.bundled = path.join(context.extensionUri.fsPath, 'library');
		this.runtimeFile = path.join(context.extensionUri.fsPath, 'library-static', 'runtime.lua');
		this.version = `${context.extension.packageJSON.version}+${readText(path.join(this.bundled, 'stamp')).trim()}`;
		fs.mkdirSync(this.remote, { recursive: true });
	}

	get storagePath(): string {
		return this.storage;
	}

	private libraryPath(stamp: string): string {
		return path.join(this.storage, `library-${stamp}`);
	}

	private isLibrary(dir: string): boolean {
		return exists(path.join(dir, 'lsmp', 'api.lua')) && exists(path.join(dir, 'api.json'));
	}

	private readState(): State {
		try {
			return JSON.parse(readText(this.stateFile)) as State;
		} catch {
			return {};
		}
	}

	private writeState(state: State): void {
		fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
	}

	private remoteFile(name: SourceName): string {
		return path.join(this.remote, `${name}.json`);
	}

	private build(sdkText: string, nativesText: string): string {
		const temp = path.join(this.storage, `library-tmp-${randomBytes(4).toString('hex')}`);
		try {
			const result = generate(parseSdk(sdkText), parseNatives(nativesText), readText(this.runtimeFile), temp);
			if (result.functions === 0 || result.natives === 0) throw new Error('generated library is empty');
			const target = this.libraryPath(result.stamp);
			if (this.isLibrary(target)) fs.rmSync(temp, { recursive: true, force: true });
			else {
				fs.rmSync(target, { recursive: true, force: true });
				fs.renameSync(temp, target);
			}
			this.log.appendLine(`generated library ${result.stamp}: ${result.functions} functions, ${result.natives} natives`);
			return result.stamp;
		} catch (error) {
			fs.rmSync(temp, { recursive: true, force: true });
			throw error;
		}
	}

	private installBundled(): string {
		const stamp = readText(path.join(this.bundled, 'stamp')).trim();
		const target = this.libraryPath(stamp);
		if (!this.isLibrary(target)) {
			fs.rmSync(target, { recursive: true, force: true });
			fs.cpSync(this.bundled, target, { recursive: true });
			this.log.appendLine(`installed bundled library ${stamp}`);
		}
		return stamp;
	}

	current(): string {
		const state = this.readState();
		if (state.stamp && state.extensionVersion === this.version && this.isLibrary(this.libraryPath(state.stamp))) return this.libraryPath(state.stamp);

		let stamp: string | undefined;
		if (state.extensionVersion !== this.version && exists(this.remoteFile('sdk')) && exists(this.remoteFile('natives'))) {
			try {
				stamp = this.build(readText(this.remoteFile('sdk')), readText(this.remoteFile('natives')));
			} catch (error) {
				this.log.appendLine(`regeneration from the cached data failed: ${(error as Error).message}`);
			}
		}
		stamp ??= this.installBundled();
		this.writeState({ ...state, stamp, extensionVersion: this.version });
		this.cleanup(stamp, state.stamp);
		return this.libraryPath(stamp);
	}

	update(): Promise<UpdateOutcome> {
		this.running ??= this.runUpdate().finally(() => (this.running = undefined));
		return this.running;
	}

	private async runUpdate(): Promise<UpdateOutcome> {
		const state = this.readState();
		try {
			const texts: Partial<Record<SourceName, string>> = {};
			const validators: Partial<Record<SourceName, Validator>> = { ...state.validators };
			let changed = false;
			for (const name of Object.keys(SOURCES) as SourceName[]) {
				const cached = exists(this.remoteFile(name));
				const result = await fetchSource(SOURCES[name], cached ? state.validators?.[name] : undefined);
				if (result.changed) {
					texts[name] = result.text;
					validators[name] = result.validator;
					changed = true;
				} else texts[name] = readText(this.remoteFile(name));
			}
			this.log.appendLine(`checked lsmp.gg: ${changed ? 'new data' : 'no change'}`);
			if (!changed) {
				this.writeState({ ...state, checkedAt: Date.now() });
				return { status: 'unchanged' };
			}

			const previous = state.stamp ? this.libraryPath(state.stamp) : undefined;
			const stamp = this.build(texts.sdk as string, texts.natives as string);
			for (const name of Object.keys(texts) as SourceName[]) fs.writeFileSync(this.remoteFile(name), texts[name] as string);
			this.writeState({ stamp, extensionVersion: this.version, checkedAt: Date.now(), validators });
			if (stamp === state.stamp) return { status: 'unchanged' };

			const summary = this.record(previous, stamp, state.stamp);
			this.cleanup(stamp, state.stamp);
			return { status: 'updated', library: this.libraryPath(stamp), summary };
		} catch (error) {
			const message = (error as Error).message;
			this.log.appendLine(`update failed: ${message}`);
			return { status: 'failed', error: message };
		}
	}

	private snapshotOf(library: string | undefined): Snapshot | undefined {
		try {
			return library ? (JSON.parse(readText(path.join(library, 'snapshot.json'))) as Snapshot) : undefined;
		} catch {
			return undefined;
		}
	}

	history(): ChangeEntry[] {
		try {
			return JSON.parse(readText(this.historyFile)) as ChangeEntry[];
		} catch {
			return [];
		}
	}

	private record(previous: string | undefined, stamp: string, from: string | undefined): string {
		const before = this.snapshotOf(previous);
		const after = this.snapshotOf(this.libraryPath(stamp));
		if (!before || !after) return 'definitions changed';
		const changes = diff(before, after);
		const entry: ChangeEntry = { date: Date.now(), from: from ?? '', to: stamp, changes };
		fs.writeFileSync(this.historyFile, JSON.stringify([entry, ...this.history()].slice(0, HISTORY)));
		return summarize(changes);
	}

	private cleanup(current: string, previous: string | undefined): void {
		const keep = new Set([current, previous].filter(Boolean).slice(0, KEEP_LIBRARIES).map((stamp) => `library-${stamp}`));
		for (const entry of fs.readdirSync(this.storage, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith('library-') && !entry.name.startsWith('library-tmp-') && !keep.has(entry.name)) {
				fs.rmSync(path.join(this.storage, entry.name), { recursive: true, force: true });
			}
		}
	}
}
