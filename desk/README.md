# Mihomo Desk 0.1.0 Windows preview

A portable tray process owns an isolated Mihomo core and a loopback web server.
The management interface opens in your ordinary Edge/Chrome browser; it does
not create a WebView2 window. Node is bundled, so users do not install Node.
The original Clash Verge Rev application remains available in this repository.

## Start

1. Extract **the complete ZIP** to a writable directory.
2. Run `MihomoDesk.exe` on Windows x64 with .NET Framework 4.8 or newer.
3. The browser opens automatically. Left-click the tray icon to reopen it;
   right-click for core control, system proxy control, the data folder and Exit.
4. Add a subscription URL, upload a YAML file, or paste a Mihomo configuration.
5. Save your global/profile YAML and visual rule drafts. Validate, then Apply.
6. Use Nodes to select a real core node and measure delay. Choose the mode on
   Overview. Enable the system proxy explicitly if desired.

Closing the browser leaves the tray, web server and Mihomo running. A second
launch with the same data directory opens the existing instance. Exit from the
tray closes owned processes and restores owned system-proxy settings. It never
installs, stops, or changes the existing clash-verge-service.

Default data: `%LOCALAPPDATA%\MihomoDesk`. Default proxy: `127.0.0.1:17890`.
Controller: `127.0.0.1:19090`. The browser server uses a free loopback port.
If these ports are occupied, the core reports an error instead of taking over
the listener. To use a separate test instance:

```powershell
.\MihomoDesk.exe --data-dir "C:\temp\MihomoDesk-test" --mixed-port 27890 --controller-port 29090 --no-open
```

Only enable the system proxy when you intend to change the current user's
proxy. Enabling records the original values; stop/restart/Exit restores them.
If another application changes these values afterward, Desk preserves the newer
settings. The process Job closes its descendants on a tray crash. A forced OS
termination cannot run registry cleanup; restart Desk to restore any saved owned
proxy setting, or use `MihomoDesk.exe --proxy-off --data-dir <directory>`.

## Configuration behavior

Raw subscriptions, global YAML, per-profile YAML and ordered visual rules are
saved separately in `state.json`. Updating an active subscription fetches new
raw YAML, composes it with saved personal edits, validates it using Mihomo `-t`,
and applies it. Failure leaves the old raw subscription and runtime intact.
Inactive subscription updates are saved for validation when applied.

Precedence is raw YAML → global YAML → profile YAML → visual rules → owned
runtime fields. This ports the global/profile YAML precedence from upstream.
Mappings merge recursively; **arrays, including proxy-groups, replace in full**,
not by name. DNS children replace shallowly; hosts replaces in full, matching
upstream. `prepend-rules` and `append-rules` are not YAML merge directives in
upstream; use the visual rule editor for these operations.

Visual rules support type, value, target, enable/disable, no-resolve, reorder,
prepend, append-before-MATCH, and replacement of the complete rules array.
Unknown policies and unreachable rules after MATCH fail composition. Mihomo
validates the full resulting YAML before replacing runtime.yaml. Failed reload
or persistence restores the previous runtime; failed rollback stops the core.
Saving a draft alone has no runtime effect. Save unsaved editors before using
Validate/Apply or changing the selected profile.

Only loopback listeners are used. Bearer authentication, Host/Origin checks,
JSON-only writes and CSP protect the management API. Credentials enter the
browser through the launch URL fragment, then move to sessionStorage; a new
server run generates new tokens. Do not share launch URLs or instance.json.
Subscriptions and secrets are local plaintext files; protect your Windows account
and data directory. There is no arbitrary invoke, shell or file-access API.

## First-version limits

- Script overrides, ordered custom enhancement chains and Verge data import
  are not implemented. This ports YAML behavior, not the whole Tauri backend.
- Automatic subscription refresh, desktop notifications, updater, deep links,
  service installation, autostart and Verge's full settings pages are absent.
- TUN, additional listeners/tunnels, LAN exposure and DNS listening are disabled
  to keep the first version isolated. A subscription may use internal DNS.
- Local file providers are rejected; HTTP providers use managed isolated paths.
- Live status/logs are polled, not delivered through upstream Tauri events.
- Subscription downloads use a direct connection; provider/geodata downloads
  depend on the core configuration and network. Speed tests use Google's 204 URL.
- The portable executable is unsigned. No claim is made about endpoint-control
  software compatibility, and no process disguise or security evasion is used.
- A tray crash closes owned processes but requires restart for system-proxy
  recovery. A graceful stop/Exit performs recovery immediately.

## Build and behavior tests

From `desk/`, with Node 24+ on Windows and the .NET Framework C# compiler:

```powershell
npm ci --ignore-scripts
npm run build:windows
npm test
```

To repeat the packaged Windows/Edge UI and process-cleanup test with Edge installed:

```powershell
npm install --prefix .build/ui --ignore-scripts playwright
node test/ui.mjs
```

The automated checks exercise both the source server and the packaged executable.
They cover Edge import/edit/validation/apply flows, real proxy selection and
traffic, mode persistence, subscription updates, invalid configuration retention,
authentication, foreign Origin/Host rejection, browser-close persistence,
single-instance reuse, graceful quit and forced-tray Job cleanup. System-proxy
registry changes are implemented but deliberately not exercised on the developer's
live Windows account. Corporate endpoint controls, real paid subscriptions,
provider/geodata downloads and the full upstream Tauri application are not verified.

The build downloads the official pinned Mihomo compatible x64 binary, compiles
the Windows Forms tray, copies Node and the YAML dependency, and produces
`release/MihomoDesk-0.1.0-win-x64.zip`. The build manifest records hashes and
versions. Tests use dedicated temporary directories, dynamically chosen ports
and an owned core. They never enable the system proxy or contact a Verge service.

Source/license: https://github.com/joshuawu95/mihomo-desk (GPL-3.0-only).
See THIRD_PARTY.md for upstream attribution and bundled notices.
