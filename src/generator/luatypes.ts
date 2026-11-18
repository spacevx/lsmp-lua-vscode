const LUA_KEYWORDS = new Set(
	'and break do else elseif end false for function goto if in local nil not or repeat return then true until while global'.split(' '),
);

export const safeName = (name: string): string => (LUA_KEYWORDS.has(name) ? `_${name}` : name.replace(/[^A-Za-z0-9_]/g, '_'));

const SIMPLE: Record<string, string> = {
	integer: 'integer',
	int: 'integer',
	uint: 'integer',
	ms: 'integer',
	epochMs: 'integer',
	playerId: 'integer',
	netId: 'integer',
	dimension: 'integer',
	handle: 'integer',
	lsmpId: 'integer|string',
	hash: 'integer|string',
	hashOut: 'integer',
	number: 'number',
	float: 'number',
	meters: 'number',
	degrees: 'number',
	heading: 'number',
	seconds: 'number',
	string: 'string',
	name: 'string',
	event: 'string',
	boolean: 'boolean',
	bool: 'boolean',
	vec3: 'lsmp.Vec3Like',
	Vec3Like: 'lsmp.Vec3Like',
	Vector3: 'Vector3',
	Vec3: 'Vector3',
	rotation: 'lsmp.Vec3Like',
	value: 'any',
	Value: 'any',
	any: 'any',
	fn: 'function',
	function: 'function',
	Function: 'function',
	table: 'table',
	list: 'any[]',
	color: 'lsmp.Color',
	Bytes: 'string',
	nil: 'nil',
	err: 'string',
	off: 'function',
	void: 'nil',
};

export interface LuaReturn {
	type: string;
	name: string | null;
}

export interface TypeMapper {
	referenced: Set<string>;
	luaType(raw: string | undefined): string;
	parseReturns(text: string | undefined): LuaReturn[];
}

function splitTopLevel(text: string, separator: string, open: string, close: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of text) {
		if (open.includes(char)) depth++;
		if (close.includes(char)) depth--;
		if (char === separator && depth === 0) {
			parts.push(current);
			current = '';
		} else current += char;
	}
	parts.push(current);
	return parts;
}

export function createTypeMapper(): TypeMapper {
	const referenced = new Set<string>();

	const luaType = (raw: string | undefined): string => {
		const type = String(raw ?? '').replace(/`/g, '').trim();
		if (!type) return 'any';
		const union = splitTopLevel(type, '|', '{[(<', '}])>');
		if (union.length > 1) return [...new Set(union.map(luaType))].join('|');
		if (type.endsWith('?')) return `${luaType(type.slice(0, -1))}?`;
		if (/^\{.*\}$/.test(type)) {
			const inner = type.slice(1, -1).trim();
			return /^[\w.]+\??$/.test(inner) ? `${luaType(inner)}[]` : 'table';
		}
		if (/^".*"$/.test(type)) return type;
		if (SIMPLE[type]) return SIMPLE[type];
		if (/^[A-Z][A-Za-z0-9]*$/.test(type)) {
			referenced.add(type);
			return type;
		}
		return 'any';
	};

	const parseReturns = (text: string | undefined): LuaReturn[] => {
		if (!text) return [];
		return splitTopLevel(text, ',', '{[(', '}])')
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => (part === 'err' ? { type: 'string?', name: 'err' } : { type: luaType(part), name: null }));
	};

	return { referenced, luaType, parseReturns };
}
