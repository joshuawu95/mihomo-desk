'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) {
  sessionStorage.setItem('mihomo-desk-token', fragment.get('token'));
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('mihomo-desk-token');
let state = { profiles: [], ruleTypes: [] };
let selectedId = null;
let status = {};
let rules = [];
let busy = false;

const transport = {
  async call(route, body) {
    const response = await fetch('/api/' + route, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  },
  async intent(action) {
    if (busy) return;
    busy = true;
    const buttons = $$('main button').map(button => [button, button.disabled]);
    buttons.forEach(([button]) => { button.disabled = true; });
    notice('正在处理…');
    try { await action(); }
    catch (error) { notice(error.message, true); }
    finally {
      busy = false;
      buttons.forEach(([button, disabled]) => { if (button.isConnected) button.disabled = disabled; });
      await refreshStatus();
    }
  },
};
function notice(message, failed = false) {
  const element = $('#notice');
  element.hidden = false;
  element.textContent = message;
  element.classList.toggle('failed', failed);
}
function current() {
  const profile = state.profiles.find(p => p.id === selectedId);
  if (!profile) throw new Error('请先添加或选择一个订阅。');
  return profile;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function actionButton(text, action) {
  const button = element('button', text);
  button.type = 'button';
  button.addEventListener('click', () => transport.intent(action));
  return button;
}
function tab(name) {
  $$('.panel').forEach(panel => { panel.hidden = panel.id !== name; });
  $$('nav button').forEach(button => button.classList.toggle('selected', button.dataset.tab === name));
  $('#page-title').textContent = $(`nav button[data-tab="${name}"]`).textContent;
  if (name === 'nodes') transport.intent(loadNodes);
}
$$('nav button').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));

async function loadState() {
  state = await transport.call('state');
  if (!state.profiles.some(p => p.id === selectedId)) selectedId = state.activeId || state.profiles[0]?.id || null;
  $('#global-yaml').value = state.globalOverride;
  $$('.profile-picker').forEach(select => {
    select.replaceChildren();
    if (!state.profiles.length) select.append(new Option('尚未添加订阅', ''));
    state.profiles.forEach(profile => select.append(new Option(profile.name, profile.id)));
    select.value = selectedId || '';
  });
  renderProfileList();
  loadProfileEditor();
}
function renderProfileList() {
  const list = $('#profile-list');
  list.replaceChildren();
  if (!state.profiles.length) list.append(element('p', '添加你的第一个订阅，或导入 YAML 文件。', 'hint'));
  for (const profile of state.profiles) {
    const row = element('div', undefined, 'profile-item');
    const label = element('div');
    label.append(element('strong', profile.name + (profile.id === state.activeId ? ' · 已应用' : '')));
    label.append(element('small', '最近更新 ' + new Date(profile.updatedAt).toLocaleString()));
    row.append(label, actionButton('选择编辑', async () => {
      selectedId = profile.id;
      $$('.profile-picker').forEach(select => { select.value = profile.id; });
      loadProfileEditor();
      notice('已选择：' + profile.name);
    }));
    list.append(row);
  }
}
function loadProfileEditor() {
  const profile = state.profiles.find(p => p.id === selectedId);
  $('#profile-name').value = profile?.name || '';
  $('#profile-url').value = profile?.url || '';
  $('#profile-raw').value = profile?.raw || '';
  $('#profile-yaml').value = profile?.override || '';
  $('#rule-mode').value = profile?.rules?.mode || 'prepend';
  rules = structuredClone(profile?.rules?.items || []);
  renderRules();
  if (profile) void loadPolicies();
}
async function loadPolicies() {
  try {
    const result = await transport.call('config/policies', { id: selectedId });
    $('#policies').replaceChildren(...result.policies.map(name => new Option(name, name)));
  } catch (error) { notice(error.message, true); }
}
$$('.profile-picker').forEach(select => select.addEventListener('change', () => {
  selectedId = select.value;
  $$('.profile-picker').forEach(other => { other.value = selectedId; });
  loadProfileEditor();
}));

$('#import-file').addEventListener('change', async event => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw new Error('文件不能超过 4 MiB');
    $('#create-profile textarea').value = await file.text();
    $('#create-profile input[name=url]').value = '';
  } catch (error) { notice(error.message, true); }
});
$('#create-profile').addEventListener('submit', event => {
  event.preventDefault();
  transport.intent(async () => {
    const body = Object.fromEntries(new FormData(event.target));
    const result = await transport.call('profile/create', body);
    selectedId = result.profile.id;
    event.target.reset();
    await loadState();
    notice('订阅已添加。可以先编辑覆写和规则，再校验并应用。');
  });
});
$('#save-profile').onclick = () => transport.intent(async () => {
  await transport.call('profile/save', { id: current().id, name: $('#profile-name').value,
    url: $('#profile-url').value, raw: $('#profile-raw').value });
  await loadState();
  notice('订阅资料已保存。运行配置尚未改变。');
});
$('#update-profile').onclick = () => transport.intent(async () => {
  const result = await transport.call('profile/update', { id: current().id });
  await loadState();
  notice(result.status === 'applied' ? '订阅已更新并应用，个人覆写及规则已保留。' : '订阅已更新，个人覆写及规则已保留。');
});
$('#delete-profile').onclick = () => transport.intent(async () => {
  const profile = current();
  if (!confirm('删除订阅“' + profile.name + '”及其个人覆写和规则？')) return;
  await transport.call('profile/delete', { id: profile.id });
  selectedId = null;
  await loadState();
  notice('订阅已删除。删除当前订阅时，后台切换为默认直连配置。');
});
async function applyProfile() {
  await transport.call('config/apply', { id: current().id });
  await loadState();
  notice('校验通过，已应用到运行配置。');
}
$('#apply-profile').onclick = () => transport.intent(applyProfile);
$$('[data-apply]').forEach(button => { button.onclick = () => transport.intent(applyProfile); });
$$('[data-validate]').forEach(button => { button.onclick = () => transport.intent(async () => {
  await transport.call('config/validate', { id: current().id });
  notice('Mihomo 校验通过。运行配置尚未改变，可点击“校验并应用”。');
}); });
$('#save-global').onclick = () => transport.intent(async () => {
  await transport.call('global/save', { yaml: $('#global-yaml').value });
  await loadState();
  notice('全局覆写草稿已保存。运行配置尚未改变。');
});
$('#save-override').onclick = () => transport.intent(async () => {
  await transport.call('profile/save', { id: current().id, override: $('#profile-yaml').value });
  await loadState();
  notice('订阅覆写草稿已保存。运行配置尚未改变。');
});
$('#preview-config').onclick = () => transport.intent(async () => {
  const result = await transport.call('config/preview', { id: current().id });
  $('#runtime-preview').value = result.yaml;
  notice('已生成保存的草稿预览。控制接口密钥已隐藏。');
});

function renderRules() {
  const body = $('#rule-rows');
  body.replaceChildren();
  rules.forEach((rule, index) => {
    const row = element('tr');
    function cell(node) { const td = element('td'); td.append(node); row.append(td); }
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled !== false;
    enabled.setAttribute('aria-label', '启用规则 ' + (index + 1));
    enabled.onchange = () => { rule.enabled = enabled.checked; }; cell(enabled);
    const type = element('select');
    state.ruleTypes.forEach(name => type.append(new Option(name, name)));
    type.value = rule.type;
    type.onchange = () => { rule.type = type.value; renderRules(); }; cell(type);
    const value = element('input'); value.value = rule.value || ''; value.disabled = rule.type === 'MATCH';
    value.setAttribute('aria-label', '匹配值'); value.oninput = () => { rule.value = value.value; }; cell(value);
    const target = element('input'); target.value = rule.target || ''; target.setAttribute('list', 'policies');
    target.setAttribute('aria-label', '目标策略'); target.oninput = () => { rule.target = target.value; }; cell(target);
    const noResolve = element('input'); noResolve.type = 'checkbox'; noResolve.checked = !!rule.noResolve;
    noResolve.disabled = !['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'SRC-IP-CIDR'].includes(rule.type);
    noResolve.setAttribute('aria-label', '不解析'); noResolve.onchange = () => { rule.noResolve = noResolve.checked; }; cell(noResolve);
    const actions = element('div');
    [['↑', -1], ['↓', 1]].forEach(([label, direction]) => {
      const button = element('button', label); button.type = 'button';
      button.disabled = index + direction < 0 || index + direction >= rules.length;
      button.onclick = () => { [rules[index], rules[index + direction]] = [rules[index + direction], rules[index]]; renderRules(); };
      actions.append(button);
    });
    const remove = element('button', '删除'); remove.onclick = () => { rules.splice(index, 1); renderRules(); };
    actions.append(remove); cell(actions); body.append(row);
  });
}
$('#add-rule').onclick = () => {
  rules.push({ type: 'DOMAIN-SUFFIX', value: '', target: 'DIRECT', enabled: true, noResolve: false });
  renderRules();
};
$('#save-rules').onclick = () => transport.intent(async () => {
  await transport.call('profile/save', { id: current().id, rules: { mode: $('#rule-mode').value, items: rules } });
  await loadState();
  notice('规则草稿已保存。请校验后应用；无效目标不会进入运行配置。');
});

async function loadNodes() {
  const result = await transport.call('proxies');
  const container = $('#node-groups');
  container.replaceChildren();
  const groups = Object.entries(result.proxies).filter(([, proxy]) => Array.isArray(proxy.all));
  if (!groups.length) container.append(element('p', '当前配置没有策略组。先导入并应用订阅。', 'hint'));
  for (const [name, group] of groups) {
    const card = element('article', undefined, 'card node-card');
    const title = element('div', undefined, 'node-title');
    title.append(element('h3', name), element('span', group.type + ' · ' + group.all.length + ' 个节点', 'badge'));
    const currentNode = element('p', '当前节点：' + (group.now || '—'), 'hint');
    const options = element('div', undefined, 'node-options');
    const select = element('select');
    group.all.forEach(node => select.append(new Option(node, node)));
    select.value = group.now || group.all[0];
    options.append(select);
    if (group.type === 'Selector') options.append(actionButton('选择节点', async () => {
      await transport.call('proxy/select', { group: name, name: select.value });
      await loadNodes(); notice('节点已切换：' + select.value);
    }));
    options.append(actionButton('测速', async () => {
      const result = await transport.call('proxy/delay', { name: select.value });
      notice(select.value + ' · ' + result.delay + ' ms');
    }));
    card.append(title, currentNode, options); container.append(card);
  }
  notice('已读取内核中的策略组和当前节点。');
}
$('#refresh-nodes').onclick = () => transport.intent(loadNodes);
$$('[data-core]').forEach(button => { button.onclick = () => transport.intent(async () => {
  await transport.call('core/' + button.dataset.core, {});
  notice('内核操作已完成。');
}); });
$$('[data-mode]').forEach(button => { button.onclick = () => transport.intent(async () => {
  await transport.call('mode', { mode: button.dataset.mode });
  notice('模式已在内核中生效。');
}); });
$('#system-proxy').onclick = () => transport.intent(async () => {
  await transport.call('system-proxy', { enabled: !status.systemProxy });
  notice(status.systemProxy ? '已恢复先前系统代理设置。' : '系统代理已启用。');
});

let polling = false;
async function refreshStatus() {
  if (polling) return;
  polling = true;
  try {
    status = await transport.call('status');
    $('#connection').textContent = status.running ? '内核运行中' : '后台在线 · 内核停止';
    $('#connection-dot').classList.toggle('on', status.running);
    $('#core-state').textContent = status.running ? '后台正在运行' : '内核已停止';
    $('#active-name').textContent = status.appliedName || '默认直连';
    $('#proxy-port').textContent = '127.0.0.1:' + status.mixedPort;
    $('#core-version').textContent = status.version || '未运行';
    $('#data-directory').textContent = status.dataDirectory;
    $('#last-error').textContent = status.lastError || '';
    $('#log-output').textContent = status.logs.join('\n');
    $('#system-proxy').textContent = status.systemProxy ? '恢复系统代理' : '开启系统代理';
    $$('[data-mode]').forEach(button => button.classList.toggle('selected', button.dataset.mode === status.mode));
  } catch (error) {
    $('#connection').textContent = '后台连接失败';
    $('#connection-dot').classList.remove('on');
    if (!busy) notice(error.message, true);
  } finally { polling = false; }
}
(async () => {
  if (!token) { notice('请从 Mihomo Desk 托盘打开管理页面，以取得本次运行的访问凭证。', true); return; }
  try { await loadState(); await refreshStatus(); setInterval(refreshStatus, 3000); }
  catch (error) { notice(error.message, true); }
})();
