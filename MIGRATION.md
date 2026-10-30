# 0.28.0: native Pi extension only

This breaking pre-1.0 minor removes pi-delegate's MCP server, executable, tools/resources and private operator settings API. The full Roles editor now lives in native Pi; advanced role settings are not JSON-only.

1. Finish and collect jobs through the old MCP service before stopping it. The native extension cannot adopt running MCP jobs or their connection-owned job IDs.
2. Remove the old pi-delegate service/client configuration, including any gateway-managed registration. Do not keep both interfaces loaded.
3. Install/load the native package with `pi install npm:@kvidzibo/pi-delegate` (or `pi install /absolute/path/to/pi-delegate` for a checkout), then `/reload`. Avoid duplicate explicit extension entries. Reload stops outstanding native children, so finish those first too.
4. Open `/pi-delegate roles` to manage enablement, available models, supported reasoning, all/none or individual tools, extension discovery, multiline prompts and new named roles. Select **Save role** to persist; Esc discards the draft. New roles require an explicit available model and nonblank prompt, with no tools/extensions and reasoning off by default.

Keep `~/.pi/agent/delegate.json` and `~/.pi/agent/delegate/` (or your archive override). Existing role overlays, unrelated/legacy keys and historical archives remain supported; no data conversion or deletion is required. Menu saves affect future jobs only. Disk conflicts require reviewing the external change and reloading after outstanding work finishes. `/pi-delegate models`, `/pi-delegate jobs` and `/pi-delegate stats` remain available.
