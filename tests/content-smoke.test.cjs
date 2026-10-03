const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// content.js를 일부만 잘라 쓰는 다른 테스트로는 선언 누락(ReferenceError)을 잡을 수 없으므로,
// manifest 순서대로 콘텐츠 스크립트 전체를 로드해 초기화와 메시지·저장소 처리기를 실제로 실행한다.
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const scripts = manifest.content_scripts[0].js.map(file => fs.readFileSync(path.join(root, file), 'utf8'));

/** 배지·툴팁 생성 코드가 쓰는 DOM API만 흉내 내는 가짜 요소 */
function element() {
  return {
    style: {}, dataset: {}, className: '', textContent: '', innerHTML: '', isConnected: true, childNodes: [],
    offsetHeight: 0, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, append() {}, prepend() {}, before() {}, after() {}, remove() {}, replaceWith() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: () => element(), querySelectorAll: () => [], closest: () => null, matches: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0 })
  };
}

async function loadContentScripts(pathname) {
  const listeners = { message: [], storage: [] };
  const errors = [];
  const document = {
    body: element(), title: '테스트',
    querySelector: () => null, querySelectorAll: () => [], createElement: () => element(), createComment: () => element(),
    addEventListener() {}, removeEventListener() {}
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
    innerHeight: 800, innerWidth: 1200, addEventListener() {}, removeEventListener() {},
    document, location: { pathname, href: `https://example.test${pathname}` },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => ({ position: 'static' }),
    requestAnimationFrame: fn => fn(),
    setTimeout: (fn, ms) => (ms >= 1000 ? fn() : setImmediate(fn)), // 초기 대기(1.5초)는 즉시 진행
    clearTimeout() {}, setImmediate,
    IntersectionObserver: class { observe() {} unobserve() {} },
    MutationObserver: class { observe() {} },
    Event: class { constructor(type) { this.type = type; } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ Count: 0, SearchResults: [] }) }),
    chrome: {
      runtime: { onMessage: { addListener: fn => listeners.message.push(fn) }, sendMessage() {} },
      storage: {
        local: { get: (keys, callback) => (callback ? callback({}) : Promise.resolve({})), set() {} },
        onChanged: { addListener: fn => listeners.storage.push(fn) }
      }
    },
    Math, Date, JSON, Promise, Map, Set, Number, String, Array, Object, RegExp, URL, encodeURIComponent, AbortSignal
  });
  context.window = context; // 브라우저처럼 window가 전역 객체를 가리키게 한다
  for (const source of scripts) vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { listeners, errors };
}

function send(listeners, message) {
  let response;
  assert.doesNotThrow(() => listeners.message.forEach(fn => fn(message, {}, value => { response = value; })));
  return response;
}

for (const [name, pathname] of [['목록', '/list/car'], ['상세', '/cars/detail/123']]) {
  test(`${name} 페이지: 콘텐츠 스크립트 전체 로드·초기화와 메시지·가중치 변경 처리에 오류가 없다`, async () => {
    const { listeners, errors } = await loadContentScripts(pathname);
    assert.equal(listeners.message.length, 1);
    assert.equal(listeners.storage.length, 1);

    const status = send(listeners, { type: 'GET_STATUS' });
    assert.equal(typeof status.processedCount, 'number');
    assert.deepEqual({ ...send(listeners, { type: 'RESCAN' }) }, { success: true });
    send(listeners, { type: 'APPLY_FILTER', minScore: 50 });
    assert.doesNotThrow(() => listeners.storage.forEach(fn => fn({ weights: { newValue: { accident: 20, mileage: 10, price: 20, inspection: 20, rental: 15, ownerChanges: 15 } } }, 'local')));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []);
  });
}
