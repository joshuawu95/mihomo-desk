import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeYaml, parseConfig, compose, applyRules } from '../config.mjs';

test('YAML port preserves upstream DNS/hosts replacement and array replacement', () => {
  const base = parseConfig('dns: {nameserver: [9.9.9.9], nameserver-policy: {old: 8.8.8.8}}\nhosts: {old: 1.2.3.4}\ntun: {mtu: 1500}\nproxy-groups: [{name: old}]');
  const overlay = parseConfig('dns: {nameserver-policy: {new: 1.1.1.1}}\nhosts: {new: 4.3.2.1}\ntun: {enable: false}\nproxy-groups: [{name: new}]');
  const result = mergeYaml(base, overlay);
  assert.deepEqual(result.dns, { nameserver: ['9.9.9.9'], 'nameserver-policy': { new: '1.1.1.1' } });
  assert.deepEqual(result.hosts, { new: '4.3.2.1' });
  assert.deepEqual(result.tun, { mtu: 1500, enable: false });
  assert.deepEqual(result['proxy-groups'], [{ name: 'new' }]);
  assert.deepEqual(mergeYaml(result, parseConfig('dns: {nameserver: [], nameserver-policy: {}}')).dns,
    { nameserver: [], 'nameserver-policy': {} });
});

test('profile YAML wins and owned listeners cannot be overridden', () => {
  const config = compose({ mode: 'rule', globalOverride: 'custom: global\nmixed-port: 7890' },
    { raw: 'custom: raw', override: 'custom: profile\ntun: {enable: true}\nexternal-controller: 0.0.0.0:9090\nlisteners: [{port: 8888}]' },
    { mixedPort: 27890, controllerPort: 29090, secret: 'test' });
  assert.equal(config.custom, 'profile');
  assert.equal(config['mixed-port'], 27890);
  assert.equal(config['external-controller'], '127.0.0.1:29090');
  assert.deepEqual(config.tun, { enable: false });
  assert.deepEqual(config.listeners, []);
});

test('visual append precedes MATCH; unknown targets and unreachable rules fail', () => {
  const config = { rules: ['DOMAIN,old.example,DIRECT', 'MATCH,DIRECT'] };
  const rule = { type: 'DOMAIN-SUFFIX', value: 'new.example', target: 'REJECT', enabled: true };
  assert.deepEqual(applyRules(config, { mode: 'append', items: [rule] }).rules,
    ['DOMAIN,old.example,DIRECT', 'DOMAIN-SUFFIX,new.example,REJECT', 'MATCH,DIRECT']);
  assert.deepEqual(applyRules(config, { mode: 'replace', items: [{ ...rule, enabled: false }] }).rules, []);
  assert.throws(() => applyRules(config, { mode: 'prepend', items: [{ ...rule, target: 'missing' }] }), /Unknown target/);
  assert.throws(() => applyRules(config, { mode: 'prepend', items: [{ type: 'MATCH', value: '', target: 'DIRECT' }] }), /last rule/);
});

test('YAML duplicate keys and unsafe object keys are rejected', () => {
  assert.throws(() => parseConfig('mode: rule\nmode: global'), /unique/);
  assert.throws(() => parseConfig('__proto__: {polluted: true}'), /Unsupported/);
  assert.throws(() => parseConfig('[1,2,3]'), /mapping/);
});
