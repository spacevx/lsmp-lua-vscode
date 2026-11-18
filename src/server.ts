import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MetricsPanel, ProcessMetrics } from './metrics';

const EXECUTABLE = process.platform === 'win32' ? 'lsmp-server.exe' : 'lsmp-server';
const QUIT_TIMEOUT_MS = 15000;
const CPU_LEVELS: [number, number] = [25, 60];
const RAM_LEVELS: [number, number] = [10, 25];

const levelColor = (percent: number, [warn, alert]: [number, number]): vscode.ThemeColor =>
	new vscode.ThemeColor(percent >= alert ? 'charts.red' : percent >= warn ? 'charts.orange' : 'charts.green');

type State = 'stopped' | 'starting' | 'running' | 'stopping';

export function findServer(): string | undefined {
	const configured = vscode.workspace.getConfiguration('lsmp').get<string>('serverPath', '').trim();
	if (configured) {
		const candidate = fs.existsSync(configured) && fs.statSync(configured).isDirectory() ? path.join(configured, EXECUTABLE) : configured;
		return fs.existsSync(candidate) ? candidate : undefined;
	}
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		let dir = folder.uri.fsPath;
		for (let depth = 0; depth < 4; depth++) {
			const candidate = path.join(dir, EXECUTABLE);
			if (fs.existsSync(candidate)) return candidate;
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return undefined;
}

export class ServerController implements vscode.Disposable {
	private child: ChildProcessWithoutNullStreams | undefined;
	private terminal: vscode.Terminal | undefined;
	private readonly write = new vscode.EventEmitter<string>();
	private readonly status: vscode.StatusBarItem;
	private state: State = 'stopped';
	private input = '';
	private opened = false;
	private pending: string[] = [];
	private exited: Promise<void> = Promise.resolve();

	readonly metrics = new ProcessMetrics();
	private readonly cpuItem: vscode.StatusBarItem;
	private readonly ramItem: vscode.StatusBarItem;
	private startedAt = 0;

	constructor(private readonly log: vscode.OutputChannel) {
		this.cpuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
		this.ramItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999.9999);
		for (const item of [this.cpuItem, this.ramItem]) item.command = 'lsmp.server.metrics';
		const totalMb = os.totalmem() / (1024 * 1024);
		this.metrics.onSample((sample) => {
			const ramPercent = (sample.ramMb / totalMb) * 100;
			this.cpuItem.text = `$(pulse) ${sample.cpu.toFixed(1)}%`;
			this.cpuItem.color = levelColor(sample.cpu, CPU_LEVELS);
			this.cpuItem.tooltip = `LS:MP server CPU: ${sample.cpu.toFixed(1)}% of the machine. Click for live charts.`;
			this.ramItem.text = `${sample.ramMb.toFixed(0)} MB`;
			this.ramItem.color = levelColor(ramPercent, RAM_LEVELS);
			this.ramItem.tooltip = `LS:MP server memory: ${sample.ramMb.toFixed(0)} MB (${ramPercent.toFixed(1)}% of ${(totalMb / 1024).toFixed(0)} GB). Click for live charts.`;
			this.cpuItem.show();
			this.ramItem.show();
		});
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000.0001);
		this.render();
		this.status.show();
	}

	private setState(state: State): void {
		this.state = state;
		void vscode.commands.executeCommand('setContext', 'lsmp.serverRunning', state === 'running' || state === 'starting');
		this.render();
	}

	private render(): void {
		const labels: Record<State, string> = { stopped: '$(debug-start) LS:MP', starting: '$(sync~spin) LS:MP', running: '$(debug-restart) LS:MP', stopping: '$(sync~spin) LS:MP' };
		this.status.text = labels[this.state];
		this.status.tooltip = this.state === 'stopped' ? 'Start the LS:MP server' : this.state === 'running' ? 'LS:MP server running: click to restart' : `LS:MP server ${this.state}`;
		this.status.command = this.state === 'stopped' ? 'lsmp.server.start' : this.state === 'running' ? 'lsmp.server.restart' : undefined;
	}

	private emit(text: string): void {
		if (this.opened) this.write.fire(text);
		else this.pending.push(text);
	}

	private print(text: string): void {
		this.emit(text.replace(/\r?\n/g, '\r\n'));
	}

	private ensureTerminal(): void {
		if (this.terminal && vscode.window.terminals.includes(this.terminal)) return;
		const pty: vscode.Pseudoterminal = {
			onDidWrite: this.write.event,
			open: () => {
				this.opened = true;
				for (const text of this.pending.splice(0)) this.write.fire(text);
			},
			close: () => {
				this.terminal = undefined;
				this.opened = false;
				void this.stop();
			},
			handleInput: (data) => this.handleInput(data),
		};
		this.terminal = vscode.window.createTerminal({ name: 'LS:MP Server', pty, iconPath: new vscode.ThemeIcon('server') });
	}

	private handleInput(data: string): void {
		for (const char of data) {
			if (char === '\r') {
				this.write.fire('\r\n');
				const line = this.input;
				this.input = '';
				if (this.child && this.state === 'running') this.child.stdin.write(`${line}\n`);
				else this.print('\x1b[90m(server not running: LS:MP: Start server)\x1b[0m\n');
			} else if (char === '\x7f' || char === '\b') {
				if (this.input.length) {
					this.input = this.input.slice(0, -1);
					this.write.fire('\b \b');
				}
			} else if (char === '\x03') {
				this.input = '';
				this.write.fire('^C\r\n');
			} else if (char >= ' ') {
				this.input += char;
				this.emit(char);
			}
		}
	}

	async start(): Promise<void> {
		if (this.child) {
			this.terminal?.show(true);
			return;
		}
		const executable = findServer();
		if (!executable) {
			const choice = await vscode.window.showErrorMessage('LS:MP: lsmp-server.exe not found. Set lsmp.serverPath.', 'Open settings');
			if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', 'lsmp.serverPath');
			return;
		}
		this.ensureTerminal();
		this.terminal?.show(true);
		this.setState('starting');
		this.print(`\x1b[90m> ${executable}\x1b[0m\n`);
		this.log.appendLine(`starting ${executable}`);

		const env: NodeJS.ProcessEnv = { ...process.env, LSMP_FORCE_COLOR: '1' };
		delete env.NO_COLOR;
		const child = spawn(executable, [], { cwd: path.dirname(executable), env, windowsHide: true });
		this.child = child;
		this.startedAt = Date.now();
		if (child.pid) this.metrics.start(child.pid);
		MetricsPanel.refresh();
		this.exited = new Promise((resolve) => child.once('exit', () => resolve()));
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			this.print(chunk);
			if (this.state === 'starting' && /listening on port/i.test(chunk)) this.setState('running');
		});
		child.stderr.on('data', (chunk: string) => this.print(`\x1b[31m${chunk}\x1b[0m`));
		child.on('error', (error) => {
			this.print(`\x1b[31m${error.message}\x1b[0m\n`);
			this.log.appendLine(`server error: ${error.message}`);
		});
		child.on('exit', (code, signal) => {
			this.print(`\x1b[90m[server exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}]\x1b[0m\n`);
			this.log.appendLine(`server exited: ${code ?? signal}`);
			this.child = undefined;
			this.metrics.stop();
			this.cpuItem.hide();
			this.ramItem.hide();
			this.setState('stopped');
		});
		setTimeout(() => {
			if (this.child === child && this.state === 'starting') this.setState('running');
		}, 20000);
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.setState('stopping');
		child.stdin.write('quit\n');
		const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), QUIT_TIMEOUT_MS));
		if ((await Promise.race([this.exited.then(() => 'exited' as const), timeout])) === 'timeout') {
			this.print('\x1b[33m[quit timed out: killing the server]\x1b[0m\n');
			child.kill();
			await this.exited;
		}
	}

	showMetrics(): void {
		MetricsPanel.show(this.metrics, () => ({ title: this.child ? `LS:MP server · pid ${this.child.pid}` : 'LS:MP server (stopped)', startedAt: this.child ? this.startedAt : 0 }));
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	dispose(): void {
		if (this.child) {
			this.child.stdin.write('quit\n');
			const child = this.child;
			setTimeout(() => child.kill(), 5000).unref();
		}
		this.status.dispose();
		this.cpuItem.dispose();
		this.ramItem.dispose();
		this.metrics.dispose();
		this.write.dispose();
		this.terminal?.dispose();
	}
}
