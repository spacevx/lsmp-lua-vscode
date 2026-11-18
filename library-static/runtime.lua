---@meta

---A 2D vector: immutable value type, `type(v) == "vector2"`, 32-bit float fields.
---@class vector2
---@field x number
---@field y number
---@operator add(vector2): vector2
---@operator sub(vector2): vector2
---@operator mul(number|vector2): vector2
---@operator div(number|vector2): vector2
---@operator unm: vector2
---@operator len: number
local vector2 = {}

---A 3D vector: immutable value type (`v.x = 1` raises), `type(v) == "vector3"`, 32-bit float fields.
---Every position the API and the natives return is one. Equal vectors are equal table keys.
---No `v + number`, no `v < w`, no `v .. ""` (use `tostring(v)`), no `v[1]`, no swizzles.
---@class vector3
---@field x number
---@field y number
---@field z number
---@operator add(vector3): vector3
---@operator sub(vector3): vector3
---@operator mul(number|vector3): vector3
---@operator div(number|vector3): vector3
---@operator unm: vector3
---@operator len: number
local vector3 = {}

---A 4D vector: immutable value type, `type(v) == "vector4"`, 32-bit float fields.
---@class vector4
---@field x number
---@field y number
---@field z number
---@field w number
---@operator add(vector4): vector4
---@operator sub(vector4): vector4
---@operator mul(number|vector4): vector4
---@operator div(number|vector4): vector4
---@operator unm: vector4
---@operator len: number
local vector4 = {}

---A rotation quaternion: immutable value type, `type(q) == "quaternion"`. `q * v` rotates a `vector3`, `q * q2` composes.
---@class quaternion
---@field x number
---@field y number
---@field z number
---@field w number
---@operator mul(vector3): vector3
---@operator mul(quaternion): quaternion
---@operator len: number
local quaternion = {}

---@alias Vector2 vector2
---@alias Vector3 vector3
---@alias Vector4 vector4
---@alias Quaternion quaternion

---Creates a `vector2`. Missing components are `0`; numeric strings are converted; a table or a vector raises.
---@param x? number
---@param y? number
---@return vector2
function Vector2(x, y) end

---Creates a `vector3`: `Vector3(1, 2, 3)`. Missing components are `0` (`Vector3()` is the origin); numeric strings are converted.
---A table or another vector raises: from a table, write `Vector3(t.x, t.y, t.z)`.
---@param x? number
---@param y? number
---@param z? number
---@return vector3
function Vector3(x, y, z) end

---Creates a `vector4`. Missing components are `0`.
---@param x? number
---@param y? number
---@param z? number
---@param w? number
---@return vector4
function Vector4(x, y, z, w) end

---Creates a `quaternion` (`Quaternion(0, 0, 0, 1)` is the identity).
---@param x? number
---@param y? number
---@param z? number
---@param w? number
---@return quaternion
function Quaternion(x, y, z, w) end

---Length (same as `#v`).
---@return number
function vector2:length() end
---Squared length.
---@return number
function vector2:length2() end
---Distance to another `vector2`.
---@param other vector2
---@return number
function vector2:distance(other) end
---Squared distance to another `vector2`.
---@param other vector2
---@return number
function vector2:distance2(other) end
---@param other vector2
---@return number
function vector2:dot(other) end
---A new unit vector (the zero vector stays zero).
---@return vector2
function vector2:normalize() end
---@param other vector2
---@param t number
---@return vector2
function vector2:lerp(other, t) end
---@param other vector2
---@return vector2
function vector2:add(other) end
---@param other vector2
---@return vector2
function vector2:sub(other) end
---@param factor number|vector2
---@return vector2
function vector2:mul(factor) end
---@return number x
---@return number y
function vector2:unpack() end
---@return string
function vector2:toString() end

---Length (same as `#v`).
---@return number
function vector3:length() end
---Squared length: cheaper for comparisons.
---@return number
function vector3:length2() end
---Distance to another `vector3` (a `{x, y, z}` table raises).
---@param other vector3
---@return number
function vector3:distance(other) end
---Squared distance to another `vector3`.
---@param other vector3
---@return number
function vector3:distance2(other) end
---@param other vector3
---@return number
function vector3:dot(other) end
---@param other vector3
---@return vector3
function vector3:cross(other) end
---A new unit vector; `v` is unchanged (the zero vector stays zero).
---@return vector3
function vector3:normalize() end
---Linear interpolation: `t = 0` gives `self`, `t = 1` gives `other`.
---@param other vector3
---@param t number
---@return vector3
function vector3:lerp(other, t) end
---Same as `self + other`.
---@param other vector3
---@return vector3
function vector3:add(other) end
---Same as `self - other`.
---@param other vector3
---@return vector3
function vector3:sub(other) end
---Same as `self * factor`.
---@param factor number|vector3
---@return vector3
function vector3:mul(factor) end
---The components as multiple values: `local x, y, z = v:unpack()`.
---@return number x
---@return number y
---@return number z
function vector3:unpack() end
---Same as `tostring(v)`: `"Vector3(1, 2, 3)"`.
---@return string
function vector3:toString() end

---@return number
function vector4:length() end
---@return number
function vector4:length2() end
---@param other vector4
---@return number
function vector4:distance(other) end
---@param other vector4
---@return number
function vector4:distance2(other) end
---@param other vector4
---@return number
function vector4:dot(other) end
---@return vector4
function vector4:normalize() end
---@param other vector4
---@param t number
---@return vector4
function vector4:lerp(other, t) end
---@param other vector4
---@return vector4
function vector4:add(other) end
---@param other vector4
---@return vector4
function vector4:sub(other) end
---@param factor number|vector4
---@return vector4
function vector4:mul(factor) end
---@return number x
---@return number y
---@return number z
---@return number w
function vector4:unpack() end
---@return string
function vector4:toString() end

---@return quaternion
function quaternion:inverse() end
---@return quaternion
function quaternion:conjugate() end
---@return quaternion
function quaternion:normalize() end
---@return number
function quaternion:length() end
---@param other quaternion
---@param t number
---@return quaternion
function quaternion:lerp(other, t) end
---Composes rotations, or rotates a `vector3` (same as `self * other`).
---@param other quaternion|vector3
---@return quaternion|vector3
function quaternion:mul(other) end
---@return number x
---@return number y
---@return number z
---@return number w
function quaternion:unpack() end
---@return string
function quaternion:toString() end

---The method table shared by every vector type: `vector.length(v)` is `v:length()`.
vector = {
	length = vector3.length,
	length2 = vector3.length2,
	distance = vector3.distance,
	distance2 = vector3.distance2,
	dot = vector3.dot,
	cross = vector3.cross,
	normalize = vector3.normalize,
	lerp = vector3.lerp,
	add = vector3.add,
	sub = vector3.sub,
	mul = vector3.mul,
	unpack = vector3.unpack,
	toString = vector3.toString,
	inverse = quaternion.inverse,
	conjugate = quaternion.conjugate,
}

---A position or direction argument: a `vector3`, `{x, y, z}` or `{x = .., y = .., z = ..}`.
---@alias lsmp.Vec3Like vector3|{x: number, y: number, z: number}|number[]

---A color: `"#rrggbb"`, `"#rrggbbaa"`, `{r, g, b[, a]}` or `{r = .., g = .., b = .., a = ..}`.
---@alias lsmp.Color string|integer[]|{r: integer, g: integer, b: integer, a?: integer}

---A rectangle: fractions of the screen (`bounds`) or pixels (`boundsPixel`).
---@class Rect
---@field x number
---@field y number
---@field width number
---@field height number

---Filter of `metaChange` (third argument of `lsmp.on`).
---@class MetaFilter
---@field scope? "global"|"player"|"entity"
---@field key? string
---@field target? integer playerId or netId.

---A callable name with its own deadline, instead of the name: `{ name = "bank:withdraw", timeoutMs = 5000 }`.
---@class CallOptions
---@field name string
---@field timeoutMs? integer 1 to 300000, default 10000.

---The connecting player in `playerPreConnection`.
---@class PreConnection
---@field name string The name they connect with.
---@field lsmpId integer? LS:MP account; `nil` for a guest.
---@field guest boolean
---@field verified boolean `true` when the LS:MP network confirmed the account.
---@field ip string? Needs the `players.identity` capability.
---@field hwid string? Needs the `players.identity` capability.
---@field deny fun(reason: string) Refuse the connection (call as `p.deny(reason)`, no colon).

---A replicated AI order (`lsmp.setEntityIntent`).
---@class EntityIntent
---@field type "idle"|"wander"|"goTo"|"follow"|"flee"|"combat"|"guard"|"custom"|"none"
---@field target? integer|"nearestPlayer"|"owner"
---@field position? lsmp.Vec3Like
---@field radius? number
---@field group? integer|string
---@field accuracy? integer 0..100
---@field keepTask? boolean
---@field mission? boolean
---@field run? boolean
---@field hatesPlayers? boolean

---JSON `null` for `lsmp.json`: keeps its place in arrays.
---@type lightuserdata
lsmp.null = nil

---Same as `lsmp.log`: writes an information line to the console of this side, prefixed with the resource name.
---@param ... any
function print(...) end

---A weather name accepted by `lsmp.weather.set` / `setLocal` (the list `lsmp.weather.getTypes()` returns).
---@alias lsmp.WeatherType
---| "EXTRASUNNY"
---| "CLEAR"
---| "CLOUDS"
---| "SMOG"
---| "FOGGY"
---| "OVERCAST"
---| "RAIN"
---| "THUNDER"
---| "CLEARING"
---| "NEUTRAL"
---| "SNOW"
---| "BLIZZARD"
---| "SNOWLIGHT"
---| "XMAS"
---| "HALLOWEEN"
---| "RAIN_HALLOWEEN"
---| "SNOW_HALLOWEEN"
