import { parseDocument, stringify } from 'yaml';
import { createHash } from 'node:crypto';

export function parseConfig(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) {
    throw new Error('YAML must be text under 4 MiB');
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('\n'));
  const value = doc.toJS({ maxAliasCount: 100 });
  if (value == null) return {};
  if (!mapping(value)) throw new Error('Configuration must be a YAML mapping');
  checkKeys(value);
  return value;
}

function mapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new Error('Unsupported configuration key: ' + key);
    }
    checkKeys(child);
  }
}

function deepMerge(base, overlay) {
  if (!mapping(base) || !mapping(overlay)) return structuredClone(overlay);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

// Ported from src-tauri/src/enhance/merge.rs: DNS children and hosts replace.
export function mergeYaml(base, overlay) {
  const result = structuredClone(base);
  for (const [original, value] of Object.entries(overlay)) {
    const key = original.toLowerCase();
    if (key === 'dns' && mapping(result[key]) && mapping(value)) {
      result[key] = { ...result[key], ...structuredClone(value) };
    } else if (key === 'hosts') {
      result[key] = structuredClone(value);
    } else {
      result[key] = deepMerge(result[key], value);
    }
  }
  return result;
}

export const ruleTypes = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR',
  'IP-CIDR6', 'SRC-IP-CIDR', 'GEOIP', 'GEOSITE', 'RULE-SET', 'DST-PORT',
  'SRC-PORT', 'PROCESS-NAME', 'PROCESS-PATH', 'NETWORK', 'MATCH'];

export function policyNames(config) {
  return [...new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS',
    ...(config.proxies || []).map(p => p.name),
    ...(config['proxy-groups'] || []).map(p => p.name)])];
}

export function applyRules(config, editor = { mode: 'prepend', items: [] }) {
  if (!['prepend', 'append', 'replace'].includes(editor.mode) || !Array.isArray(editor.items)) {
    throw new Error('Invalid rule editor');
  }
  const policies = new Set(policyNames(config));
  const rules = editor.items.filter(r => r.enabled !== false).map(rule => {
    if (!ruleTypes.includes(rule.type)) throw new Error('Unsupported rule type');
    if (!policies.has(rule.target)) throw new Error('Unknown target policy: ' + rule.target);
    if (typeof rule.value !== 'string' || /[,\r\n]/.test(rule.value)) {
      throw new Error('Rule value must be a single field without commas');
    }
    if (rule.type !== 'MATCH' && !rule.value.trim()) throw new Error('Rule value is required');
    const parts = rule.type === 'MATCH' ? ['MATCH', rule.target]
      : [rule.type, rule.value.trim(), rule.target];
    if (rule.noResolve && ['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'SRC-IP-CIDR'].includes(rule.type)) {
      parts.push('no-resolve');
    }
    return parts.join(',');
  });
  const original = config.rules || [];
  if (!Array.isArray(original) || original.some(r => typeof r !== 'string')) {
    throw new Error('rules must be an array of strings');
  }
  let final;
  if (editor.mode === 'replace') final = rules;
  else if (editor.mode === 'prepend') final = [...rules, ...original];
  else {
    const match = original.findIndex(r => /^\s*(MATCH|FINAL)\s*,/i.test(r));
    const index = match < 0 ? original.length : match;
    final = [...original.slice(0, index), ...rules, ...original.slice(index)];
  }
  const match = final.findIndex(r => /^\s*(MATCH|FINAL)\s*,/i.test(r));
  if (match >= 0 && match !== final.length - 1) {
    throw new Error('MATCH must be the last rule; rules after it would never run');
  }
  return { ...config, rules: final };
}

export function compose(state, profile, controls) {
  let config = parseConfig(profile?.raw || 'proxies: []\nproxy-groups: []\nrules: ["MATCH,DIRECT"]');
  config = mergeYaml(config, parseConfig(state.globalOverride || ''));
  config = mergeYaml(config, parseConfig(profile?.override || ''));
  config = applyRules(config, profile?.rules);
  for (const field of ['external-controller', 'external-controller-unix',
    'external-controller-pipe', 'external-controller-tls', 'external-controller-cors',
    'external-ui', 'external-ui-url', 'external-ui-name', 'certificate', 'private-key']) {
    delete config[field];
  }
  Object.assign(config, {
    'external-controller': '127.0.0.1:' + controls.controllerPort,
    secret: controls.secret, 'mixed-port': controls.mixedPort,
    port: 0, 'socks-port': 0, 'redir-port': 0, 'tproxy-port': 0,
    'allow-lan': false, 'bind-address': '127.0.0.1',
    mode: state.mode || 'rule', 'log-level': 'info',
    tun: { enable: false }, listeners: [], tunnels: [],
  });
  if (mapping(config.dns)) config.dns.listen = '';
  for (const field of ['proxy-providers', 'rule-providers']) {
    if (!config[field]) continue;
    for (const [name, provider] of Object.entries(config[field])) {
      if (!mapping(provider)) throw new Error('Invalid provider: ' + name);
      if (provider.type === 'file') throw new Error('Local file providers are not supported in the portable client');
      if (provider.type === 'http') {
        const url = new URL(provider.url);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid provider URL');
        provider.path = './providers/' + createHash('sha256').update(field + name).digest('hex') + '.yaml';
      }
    }
  }
  return config;
}

export function dumpConfig(config, redact = false) {
  if (redact) config = { ...config, secret: '[managed by Mihomo Desk]' };
  return stringify(config, { lineWidth: 0 });
}
