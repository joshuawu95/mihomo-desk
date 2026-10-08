# Third-party software

Mihomo Desk is distributed under GPL-3.0-only. The enclosing repository retains
the Clash Verge Rev sources, author credits and license. YAML enhancement
semantics in `config.mjs` are ported from `src-tauri/src/enhance/merge.rs` and
`src-tauri/src/enhance/mod.rs`. The portable entry point and browser interface
are implemented independently of Tauri.

- Clash Verge Rev: https://github.com/clash-verge-rev/clash-verge-rev
  (GPL-3.0-only; original authors and contributors remain credited upstream).
- Mihomo: https://github.com/MetaCubeX/mihomo (GPL-3.0; bundled license in core/).
- Node.js: https://nodejs.org (MIT and third-party notices in runtime/LICENSE-Node.txt).
- yaml 2.8.1: https://github.com/eemeli/yaml (ISC; license in node_modules/yaml/LICENSE).
- Windows tray: uses the Windows .NET Framework and Windows system APIs.

Corresponding application source is in the `desk/` directory of
https://github.com/joshuawu95/mihomo-desk/tree/feat/browser-desk/desk
and is also bundled under `source/desk/`. The manifest records the Mihomo version;
its corresponding source is available at the matching tag in the Mihomo repository.
The Node version and all bundled file hashes are recorded in build-manifest.json.
