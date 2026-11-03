import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../panel.js', import.meta.url), 'utf8');
const marker = "    return {\n      inject: ['slots'],";
assert.equal(source.split(marker).length, 2, 'one factory export marker for test-only instrumentation');
const instrumented = source.replace(marker,
  "    globalThis.__panelTest = { pieSlices, arcPath, PieChart, Dashboard, Panel, money, csvCell, modelCsv, validateReport };\n" + marker);
const node = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) });
function load({ states = [], globals = {} } = {}) {
  const effects = [], refs = [], setters = [], initialStates = [];
  let stateIndex = 0;
  const React = {
    Fragment: Symbol('Fragment'), createElement: node,
    useState(initial) {
      const index = stateIndex++;
      initialStates.push(initial);
      const value = index in states ? states[index] : (typeof initial === 'function' ? initial() : initial);
      return [value, next => setters.push({ index, value: next })];
    },
    useEffect(effect) { effects.push(effect); },
    useRef(value) { const ref = { current: value }; refs.push(ref); return ref; },
    useMemo(fn) { return fn(); },
  };
  let plugin;
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { plugin = value; } } },
    Intl, URL, AbortController, Blob, setTimeout, clearTimeout, setInterval, clearInterval,
    ...globals,
  });
  vm.runInContext(instrumented, context, { filename: 'usage/panel.js' });
  plugin.factory(name => { assert.equal(name, 'react'); return React; });
  return { api: context.__panelTest, effects, refs, setters, initialStates };
}
function expand(value) {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value !== 'object') return value;
  if (typeof value.type === 'function') return expand(value.type({ ...value.props, children: value.children }));
  return { ...value, children: value.children.map(expand).filter(child => child !== null) };
}
function elements(value, predicate = () => true, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (predicate(value)) result.push(value);
  for (const child of value.children || []) elements(child, predicate, result);
  return result;
}
function text(value, visibleOnly = false) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (value.type === 'style' || value.type === 'title') return '';
  const children = visibleOnly && value.type === 'details' && !value.props.open ? value.children.filter(child => child?.type === 'summary') : value.children;
  return children.map(child => text(child, visibleOnly)).join(' ');
}
const row = (model, total, cost, tokenShare = 1, costShare = 1) => ({
  provider: 'OpenAI', model, input: total, output: 0, cacheRead: 0, cacheWrite: 0,
  total, calls: 1, sessions: 1, cost, tokenShare, costShare,
  unpricedCalls: cost === null ? 1 : 0, price: null,
});
function report(models = [row('gpt-test', 100, 1)]) {
  return {
    generatedAt: '2026-11-03T11:00:00Z', range: 'today', timeZone: 'Asia/Shanghai', scopeLabel: '本机 DSH 会话',
    totals: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100, calls: models.length, sessions: 1, cost: 1, unpricedCalls: 0 },
    models, daily: [], warnings: ['完整警告：仅用于折叠详情。'], coverage: { sessions: 1, files: 1, invalidRecords: 0 },
  };
}

test('pie sectors preserve actual value proportions, including arbitrarily small shares', () => {
  const { api } = load();
  const slices = api.pieSlices([row('a', 25, 1), row('b', 75, 3)], 'token');
  assert.equal(slices[0].share, .25);
  assert.equal(slices[1].share, .75);
  assert.ok(Math.abs(slices[0].end - slices[0].start - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(slices[1].end - slices[1].start - 3 * Math.PI / 2) < 1e-12);
  assert.match(api.arcPath(slices[0].start, slices[0].end), / A 128 128 0 0 1 /);
  assert.match(api.arcPath(slices[1].start, slices[1].end), / A 128 128 0 1 1 /);
  const tiny = api.pieSlices([row('tiny', 1, 1), row('large', 999999999, 1)], 'token')[0];
  assert.equal(tiny.share, 1e-9);
  assert.ok(tiny.end - tiny.start < 1e-7, 'small slice must not be enlarged for visibility');
});

test('model colors stay stable across mode, sort order and selected time range', () => {
  const { api } = load();
  const models = [row('gpt-6.1-sol', 90, 1), row('deepseek-flash', 10, 9), row('MiniMax-M3.1-Flash', 1, .1)];
  const token = api.pieSlices(models, 'token');
  const cost = api.pieSlices([...models].reverse(), 'cost');
  for (const slice of token) assert.equal(slice.color, cost.find(item => item.model.model === slice.model.model).color);
  assert.equal(new Set(token.map(slice => slice.color)).size, 3, 'current three model families have distinct muted colors');
  assert.equal(api.pieSlices([models[1]], 'token')[0].color, token[1].color);
});

test('single positive model is a real full ring, zero and null data have no painted sectors', () => {
  const { api } = load();
  const single = expand(api.PieChart({ models: [row('only', 100, 2)], mode: 'token', totals: { total: 100, cost: 2 } }));
  const sectors = elements(single, element => element.props.className === 'mu-sector');
  assert.equal(sectors.length, 1);
  assert.equal(sectors[0].type, 'circle');
  assert.equal(sectors[0].props['data-share'], 1);
  assert.equal(elements(single, element => element.type === 'svg')[0].props.role, 'img');
  assert.ok(elements(single, element => element.type === 'title').length >= 2);
  const zero = expand(api.PieChart({ models: [row('zero', 0, 0)], mode: 'token', totals: { total: 0, cost: 0 } }));
  assert.equal(elements(zero, element => element.props.className === 'mu-sector').length, 0);
  assert.match(elements(zero, element => element.type === 'svg')[0].props['aria-label'], /暂无可绘制数据/);
  const unknown = expand(api.PieChart({ models: [row('unknown', 100, null)], mode: 'cost', totals: { total: 100, cost: null } }));
  assert.equal(elements(unknown, element => element.props.className === 'mu-sector').length, 0);
  assert.match(text(unknown), /未定价/);
  assert.doesNotMatch(text(unknown), /\$0\.00/);
});

test('cost pie excludes unknown prices without assigning them a zero-price percentage', () => {
  const { api } = load();
  const slices = api.pieSlices([row('a', 10, 1), row('b', 20, 3), row('unknown', 70, null)], 'cost');
  assert.equal(slices[0].share, .25);
  assert.equal(slices[1].share, .75);
  assert.equal(slices[2].share, null);
  assert.equal(slices[2].value, null);
  const legend = expand(api.PieChart({ models: slices.map(slice => slice.model), mode: 'cost', totals: { total: 100, cost: 4 } }));
  assert.equal(elements(legend, element => element.type === 'li').length, 3, 'unknown model stays in the legend');
});

test('dashboard contains only metrics, pie and one model table; detail content is entirely removed', () => {
  const { api } = load();
  const data = report();
  data.coverage.failedSessions = 1;
  data.warnings.push('会话无法读取，统计不完整。');
  const tree = expand(api.Dashboard({ report: data, mode: 'token', onModeChange() {} }));
  assert.equal(elements(tree, element => element.props.className === 'mu-metric').length, 4);
  const mainTable = elements(tree, element => element.type === 'table')[0];
  assert.equal(elements(mainTable, element => element.type === 'th').length, 5);
  assert.equal(elements(tree, element => element.type === 'details' || element.type === 'summary').length, 0);
  assert.equal(elements(tree, element => element.type === 'table').length, 1);
  assert.doesNotMatch(text(tree), /详情|完整警告|会话无法读取|官方单价|未缓存输入|OpenAI|模型路由|面板打开时|部分数据/);
  const totalMetric = elements(tree, element => element.props.className === 'mu-metric-value')[0];
  assert.match(totalMetric.props.title, /部分会话未计入/, 'data quality remains available on hover without a details section');
  assert.equal(elements(tree, element => element.type === 'svg' && element.props.role === 'img').length, 1);
});

test('unknown total and model fees remain explicitly unpriced; display money is concise', () => {
  const { api } = load();
  assert.equal(api.money(null), '未定价');
  assert.equal(api.money(12.345678), '$12.35');
  assert.equal(api.money(.0025), '$0.0025');
  assert.equal(api.money(.0000001), '< $0.000001');
  const data = report([row('unknown', 100, null)]);
  data.totals.cost = null; data.totals.unpricedCalls = 1;
  const tree = expand(api.Dashboard({ report: data, mode: 'cost', onModeChange() {} }));
  assert.match(text(tree, true), /未定价/);
  assert.match(elements(tree, element => element.props.className === 'mu-metric-value')[1].props.title, /部分估算/);
  assert.doesNotMatch(text(tree, true), /\$0\.00/);
  assert.doesNotThrow(() => api.validateReport(data, 'today'));
  assert.throws(() => api.validateReport(data, 'month'));
});

test('CSV neutralizes formulas, preserves null as empty and does not export warning/chat content', () => {
  const { api } = load();
  for (const value of ['=cmd()', '+1', '-42', '@SUM(A1)', ' \t=1', '\uFEFF=1']) assert.ok(api.csvCell(value).startsWith('"\''));
  assert.equal(api.csvCell(null), '""');
  assert.equal(api.csvCell('a"b'), '"a""b"');
  const csv = api.modelCsv([{ ...row('=malicious()', 100, null), content: 'SECRET CHAT', warning: 'SECRET WARNING' }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /'\=malicious/);
  assert.doesNotMatch(csv, /SECRET/);
});

test('panel starts in token mode; visible polling uses authenticated GET, prevents overlap and cancels stale results', async () => {
  const intervals = [], timeouts = [], clearedIntervals = [], clearedTimeouts = [], requests = [];
  let resolveFetch;
  const pending = new Promise(resolve => { resolveFetch = resolve; });
  const { api, effects, setters, initialStates } = load({
    states: ['today', 'token', null, false, '', '', '', true],
    globals: {
      fetch(url, options) { requests.push({ url, options }); return pending; },
      setInterval(fn, ms) { const token = { fn, ms }; intervals.push(token); return token; },
      clearInterval(token) { clearedIntervals.push(token); },
      setTimeout(fn, ms) { const token = { fn, ms }; timeouts.push(token); return token; },
      clearTimeout(token) { clearedTimeouts.push(token); },
    },
  });
  api.Panel();
  assert.equal(initialStates[1], 'token');
  const cleanup = effects[1]();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/model-usage?range=today');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(intervals[0].ms, 60000);
  assert.equal(timeouts[0].ms, 45000);
  await intervals[0].fn();
  assert.equal(requests.length, 1, 'pending requests must not overlap');
  cleanup();
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(clearedIntervals.length, 1);
  assert.ok(clearedTimeouts.includes(timeouts[0]));
  resolveFetch({ ok: true, async json() { return report(); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setters.filter(item => item.index === 2).length, 0, 'late responses cannot update an unmounted/hidden panel');
});

test('visibility observer and page visibility pause polling and clean up listeners', () => {
  let observer, listener, removed = false, disconnected = false;
  const document = { visibilityState: 'visible', addEventListener(name, fn) { assert.equal(name, 'visibilitychange'); listener = fn; }, removeEventListener(name, fn) { removed = name === 'visibilitychange' && fn === listener; } };
  class Observer { constructor(fn) { this.callback = fn; observer = this; } observe() {} disconnect() { disconnected = true; } }
  const { api, effects, refs, setters } = load({ globals: { document, IntersectionObserver: Observer } });
  api.Panel(); refs[0].current = {};
  const cleanup = effects[0]();
  observer.callback([{ isIntersecting: true }]);
  assert.equal(setters.at(-1).value, true);
  document.visibilityState = 'hidden'; listener();
  assert.equal(setters.at(-1).value, false);
  cleanup();
  assert.equal(removed, true); assert.equal(disconnected, true);
});
