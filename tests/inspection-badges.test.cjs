const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const counts = overrides => ({
  ONE: { X: 0, W: 0, C: 0 }, TWO: { X: 0, W: 0, C: 0 },
  A: { X: 0, W: 0, C: 0 }, B: { X: 0, W: 0, C: 0 }, ...overrides
});

/** 실제 배지/툴팁/복사 경로를 실행하되 네트워크와 브라우저 DOM만 대체한다. */
function setup(pathname = '/list/car') {
  const created = [];
  let clipboard = '';
  function element() {
    const children = new Map();
    const item = {
      style: {}, dataset: {}, childNodes: [], innerHTML: '', events: {},
      append() {}, appendChild() {}, before() {}, remove() {},
      addEventListener(name, fn) { this.events[name] = fn; },
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
      getBoundingClientRect: () => ({ top: 100, right: 200, bottom: 150 })
    };
    created.push(item);
    return item;
  }
  const scope = vm.createContext({
    Date, console, location: { pathname },
    document: { createElement: element, createComment: element, querySelector: () => null, body: element() },
    localStorage: { getItem: () => null }, setTimeout() {},
    navigator: { clipboard: { writeText: async text => { clipboard = text; } } }
  });
  scope.window = scope;
  for (const file of JSON.parse(read('manifest.json')).content_scripts[0].js.filter(file => file !== 'content.js')) {
    vm.runInContext(read(file), scope);
  }
  const source = read('content.js');
  vm.runInContext(source.slice(source.indexOf('  function escapeHtml('), source.indexOf('  function createLoadingBadge(')), scope);
  return {
    render(data) {
      // 수리 표시 테스트에서는 이미 받은 툴팁 데이터를 사용하고 부가 조회는 시작하지 않는다.
      data = { ...data, tooltipExtrasLoaded: true };
      const before = JSON.stringify(data);
      const score = scope.EncarScoring.calculateScore(data);
      const badge = scope.createScoreBadge(score, { carId: '1' }, null, data);
      assert.equal(JSON.stringify(data), before, '표시 변경은 원본 데이터에 영향을 주지 않는다');
      return { badge, score, html: created.find(item => item.className === 'encar-score-tooltip').innerHTML };
    },
    async copy(badge) {
      badge.events.click({ preventDefault() {}, stopPropagation() {} });
      const menu = created.find(item => item.className === 'encar-action-menu');
      menu.querySelector('[data-action="copy"]').events.click({ stopPropagation() {} });
      await Promise.resolve();
      return clipboard;
    }
  };
}

test('목록·상세: 골격/외판 교환·판금·부식을 개수와 함께 개별 타원형 배지로 표시', async () => {
  for (const pathname of ['/list/car', '/cars/detail/1']) {
    const ui = setup(pathname);
    const data = {
      carId: '1', hasInspection: true, hasReplacement: true, hasWelding: true, hasCorrosion: true,
      rankCounts: counts({ A: { X: 1, W: 2, C: 0 }, ONE: { X: 3, W: 4, C: 1 } })
    };
    const { badge, html } = ui.render(data);
    for (const label of ['골격 교환 1', '골격 판금 2', '외판 교환 3', '외판 판금 4', '부식 1']) {
      assert.ok(html.includes(`<span class="encar-inspection-repair">${label}</span>`));
    }
    assert.equal((html.match(/class="encar-inspection-repair"/g) || []).length, 5);
    const copied = await ui.copy(badge);
    assert.match(copied, /성능점검: 교환 \/ 판금 \/ 부식/);
    assert.doesNotMatch(copied, /encar-inspection-repair|<span/);
  }
});

test('상세 개수가 없어도 기존 교환·판금·부식 플래그를 배지로 표시', () => {
  const { html } = setup().render({ hasInspection: true, hasReplacement: true, hasWelding: true, hasCorrosion: true });
  for (const label of ['교환', '판금', '부식']) {
    assert.ok(html.includes(`<span class="encar-inspection-repair">${label}</span>`));
  }
});

test('이상 없음·점검표 없음·비공개에는 수리 배지를 표시하지 않는다', () => {
  for (const [data, text] of [
    [{ hasInspection: true, rankCounts: counts() }, '성능점검표: 이상 없음'],
    [{ hasInspection: false, hasReplacement: true }, '성능점검표 없음'],
    [{ hasInspection: true, isInspectionPrivate: true, hasReplacement: true }, '조회불가 · 비공개']
  ]) {
    const { html } = setup().render(data);
    assert.ok(html.includes(text));
    assert.doesNotMatch(html, /class="encar-inspection-repair"/);
  }
});

test('타원형 스타일은 기존 글자 크기를 상속하고 항목 사이 줄바꿈을 허용', () => {
  const css = read('styles.css');
  const pill = css.match(/\.encar-inspection-repair\s*\{([^}]+)\}/)[1];
  const row = css.match(/\.encar-inspection-repairs\s*\{([^}]+)\}/)[1];
  assert.match(pill, /font-size:\s*inherit/);
  assert.match(pill, /border-radius:\s*9999px/);
  assert.match(row, /flex-wrap:\s*wrap/);
});
