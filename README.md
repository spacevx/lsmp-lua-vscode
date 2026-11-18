# LS:MP Lua

VS Code extension for the LS:MP GTA V platform, for Lua 5.5 (luax).

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `lsmp.enable` | `"auto"` \| `"always"` \| `"never"` | `"auto"` | `auto`: when a `manifest.json` lists scripts. `always` / `never` force it. |
| `lsmp.natives` | boolean | `true` | Include the GTA V natives. |
| `lsmp.autoUpdate` | boolean | `true` | Update the definitions from lsmp.gg automatically. |
| `lsmp.updateIntervalHours` | number | `1` | Hours between checks. `0`: only when a workspace opens. |
