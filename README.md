# LS:MP Lua

IntelliSense for the LS:MP platform (GTA V Enhanced), for Lua 5.5 (luax), with sumneko.lua.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `lsmp.enable` | `"auto"` \| `"always"` \| `"never"` | `"auto"` | `auto`: configure the Lua language server when the workspace holds an LS:MP resource (a `manifest.json` with `client_scripts`, `server_scripts` or `shared_scripts`). `always` / `never` force it. |
| `lsmp.natives` | boolean | `true` | Add the GTA V natives (client-side camelCase globals) to the completion. |
| `lsmp.autoUpdate` | boolean | `true` | Check lsmp.gg for new definitions when an LS:MP workspace opens and every `lsmp.updateIntervalHours` hours. Run **LS:MP: Update definitions from lsmp.gg** to check now. |
| `lsmp.updateIntervalHours` | number | `1` | Hours between two checks while VS Code stays open. `0`: check only when an LS:MP workspace opens. |
