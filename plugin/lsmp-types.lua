local json = require 'json'

local args = select(3, ...)
local typesFile = type(args) == 'table' and args[1] or nil

local cachedText, cachedData

local function readTypes()
	if not typesFile then return nil end
	local file = io.open(typesFile, 'rb')
	if not file then return nil end
	local text = file:read('a')
	file:close()
	if text ~= cachedText then
		cachedText = text
		local ok, data = pcall(json.decode, text)
		cachedData = ok and data or nil
	end
	return cachedData
end

local function splitParams(list)
	local params = {}
	for param in list:gmatch('[^,]+') do
		params[#params + 1] = param:match('^%s*(.-)%s*$')
	end
	return params
end

function OnSetText(uri, text)
	local data = readTypes()
	local files = data and data.files
	local entries = files and files[uri:lower()]
	if not entries then return nil end

	local diffs = {}
	for fn, quote, name, at, list in text:gmatch('lsmp%s*%.%s*(%a+)%s*%(%s*(["\'])([^"\'\n]-)%2%s*,%s*()function%s*%(([^)]*)%)') do
		local types = entries[fn .. '|' .. name]
		if types then
			local lines = {}
			for i, param in ipairs(splitParams(list)) do
				local paramType = types[i]
				if type(paramType) == 'string' and param:match('^[%a_][%w_]*$') then
					lines[#lines + 1] = '---@param ' .. param .. ' ' .. paramType
				end
			end
			if #lines > 0 then
				diffs[#diffs + 1] = { start = at, finish = at - 1, text = '\n' .. table.concat(lines, '\n') .. '\n' }
			end
		end
	end
	return #diffs > 0 and diffs or nil
end
