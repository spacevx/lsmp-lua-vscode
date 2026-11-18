export type Side = 'server' | 'client' | 'shared' | 'page';

export interface SdkParam {
	name: string;
	type: string;
	desc?: string;
	optional?: boolean;
	only?: 'lua' | 'js';
}

export interface SdkReturn {
	type: string;
	desc?: string;
	only?: 'lua' | 'js';
}

export interface SdkTable {
	type: 'table';
	headers: string[];
	rows: string[][];
}

export interface SdkCallout {
	type: 'callout';
	title?: string;
	md?: string;
}

export type SdkNote = SdkTable | SdkCallout | { type: string };

export interface SdkExampleTab {
	label: string;
	lang: string;
	code: string;
}

export interface SdkFunction {
	type: 'function';
	name: string;
	id?: string;
	side?: Side;
	engines?: string[];
	signature: { lua?: string; js?: string };
	summary?: string;
	md?: string;
	params?: SdkParam[];
	returns?: SdkReturn | SdkReturn[];
	notes?: SdkNote[];
	examples?: { tabs?: SdkExampleTab[] };
}

export interface SdkBlock {
	type: string;
	text?: string;
	headers?: string[];
	rows?: string[][];
	blocks?: SdkBlock[];
	items?: unknown[];
	[key: string]: unknown;
}

export interface SdkPage {
	id: string;
	title: string;
	blocks: SdkBlock[];
}

export interface Sdk {
	sections: { id: string; title: string; pages: SdkPage[] }[];
}

export interface NativeNote {
	kind: string;
	title: string;
	md: string;
	lang?: 'lua' | 'js';
}

export interface Native {
	name: string;
	native: string;
	hash: string;
	params?: [string, string, string?][];
	ret?: string;
	outs?: [string, string, number, string?][];
	refs?: number[];
	na?: 1;
	blocked?: string;
	checked?: 1;
	issue?: 1;
	since?: number;
	aka?: string[];
	notes?: NativeNote[];
	doc?: string;
}

export interface NativeType {
	js: string;
	lua: string;
	alias?: boolean;
	doc: string;
}

export interface Natives {
	meta: {
		results: string;
		policy: { error: string; categories: Record<string, { title: string; md: string; count: number }> };
		counts: Record<string, number>;
	};
	types: Record<string, NativeType>;
	namespaces: { id: string; title: string; doc?: string; natives: Native[] }[];
	withheld: { native: string; hash?: string; md: string }[];
}

export const isFunction = (block: SdkBlock): block is SdkBlock & SdkFunction =>
	block.type === 'function' && typeof block.name === 'string' && typeof block.signature === 'object';

export const isTable = (note: SdkNote | SdkBlock): note is SdkTable =>
	note.type === 'table' && Array.isArray((note as SdkTable).headers);
