const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const now = Date.parse('2026-10-03T12:00:00+09:00');
const context = vm.createContext({ Date });
vm.runInContext(`${read('owner-history.js')}\nthis.history = OwnerHistory;`, context);
const { estimate, describe } = context.history;
const car = (dates, overrides = {}) => ({
  ownerChangeCount: dates.length, ownerChanges: dates, ownerHistoryComplete: true,
  firstRegistrationDate: '2014-04-14', registDateTime: '2026-04-03T14:49:33',
  firstAdvertisedDateTime: '2026-10-03T21:15:20', sellerUserType: 'DEALER', ...overrides
});
const sample = () => car(['2016-01-01', '2020-04-28', '2020-04-29', '2020-05-07', '2026-03-26']);

test('원본 5회에서 현재 매입 1회와 과거 3건 묶음의 추가분 2회만 제외해 2회 추정', () => {
  const data = sample();
  const before = JSON.stringify(data);
  const result = estimate(data, now);
  assert.equal(result.rawCount, 5);
  assert.equal(result.estimatedCount, 2);
  assert.equal(result.excludedCount, 3);
  assert.equal(result.currentDealerPurchase.date, '2026-03-26');
  assert.equal(result.historicalGroups[0].spanDays, 9);
  assert.equal(result.historicalGroups[0].excludedCount, 2);
  assert.equal(result.status, 'estimated');
  assert.equal(JSON.stringify(data), before);
  assert.equal(describe(result).text, '딜러 경유 보정 시 2회 추정');
});

test('마지막 딜러 매입 후보는 등록 전 0~30일만 제외하며 광고 재등록일에 영향받지 않음', () => {
  for (const [date, expected] of [
    ['2026-04-03', 0], ['2026-03-04', 0], ['2026-03-03', 1],
    ['2026-01-03', 1], ['2026-04-04', 1]
  ]) {
    const data = car([date]);
    assert.equal(estimate(data, now).estimatedCount, expected, date);
    assert.equal(estimate({ ...data, firstAdvertisedDateTime: null }, now).estimatedCount, expected);
  }
  assert.match(describe(estimate(car(['2026-03-26']), now)).title, /1인 소유가 확인되었다는 뜻은 아닙니다/);
});

test('개인·미확인 판매자는 현재 매입을 제외하지 않지만 과거 거래 묶기는 동일', () => {
  for (const sellerUserType of ['PERSONAL', null, undefined, 'UNKNOWN']) {
    const result = estimate({ ...sample(), sellerUserType }, now);
    assert.equal(result.currentDealerPurchase, null);
    assert.equal(result.estimatedCount, 3);
  }
  assert.equal(estimate(car(['2026-03-26'], { sellerUserType: ' dealer ' }), now).estimatedCount, 0);
});

test('전체 19일·9일·11일 사례와 같은 날 복수 변경도 보존한 채 묶음으로 계산', () => {
  for (const dates of [
    ['2019-03-27', '2019-03-27', '2019-04-15'],
    ['2020-04-28', '2020-04-29', '2020-05-07'],
    ['2020-10-15', '2020-10-23', '2020-10-26']
  ]) {
    const data = car([...dates].reverse());
    Object.freeze(data.ownerChanges);
    Object.freeze(data);
    const result = estimate(data, now);
    assert.equal(result.estimatedCount, 1);
    assert.equal(result.historicalGroups[0].dates.length, 3);
    assert.equal(new Set(result.historicalGroups[0].originalIndexes).size, 3);
    assert.equal(result.status, 'estimated');
  }
});

test('묶음 전체 30일은 허용하지만 인접 간격만 짧은 31일·72일 연쇄는 통째로 보류', () => {
  const within = estimate(car(['2025-01-01', '2025-01-15', '2025-01-31']), now);
  assert.equal(within.estimatedCount, 1);
  for (const dates of [
    ['2025-01-01', '2025-01-15', '2025-02-01'],
    ['2025-01-01', '2025-01-25', '2025-02-18', '2025-03-14']
  ]) {
    const result = estimate(car(dates), now);
    assert.equal(result.estimatedCount, dates.length);
    assert.equal(result.historicalGroups.length, 0);
    assert.equal(result.status, 'partial');
    assert.equal(describe(result).text, '딜러 경유 보정: 판정 보류');
  }
});

test('31~60일은 독립된 두 건만 보정하며 61일, 연쇄, 병합 묶음의 재병합은 제외', () => {
  for (const [date, expected] of [['2020-02-01', 1], ['2020-03-01', 1], ['2020-03-02', 2]]) {
    assert.equal(estimate(car(['2020-01-01', date]), now).estimatedCount, expected);
  }
  const chain = estimate(car(['2025-01-01', '2025-02-10', '2025-03-22']), now);
  assert.equal(chain.estimatedCount, 3);
  assert.equal(chain.status, 'partial');
  const grouped = estimate(car(['2025-01-01', '2025-01-10', '2025-02-20']), now);
  assert.equal(grouped.estimatedCount, 2);
  assert.equal(grouped.historicalGroups.length, 1);
  assert.match(describe(grouped).text, /2회 추정 · 일부 판정 보류/);
});

test('31~60일 쌍은 앞뒤 원본 변경과 각각 60일 초과 떨어져 있어야 함', () => {
  assert.equal(estimate(car(['2019-11-01', '2020-01-01', '2020-02-15', '2020-04-16']), now).estimatedCount, 3);
  const near = estimate(car(['2019-11-02', '2020-01-01', '2020-02-15', '2020-04-15']), now);
  assert.equal(near.estimatedCount, 4);
  assert.equal(near.status, 'partial');
  // 마지막 딜러 매입 후보를 제거한 뒤에도 원본의 40일 간격은 사라지지 않는다.
  const withCurrent = estimate(car(['2026-01-03', '2026-02-14', '2026-03-26']), now);
  assert.equal(withCurrent.estimatedCount, 2);
  assert.equal(withCurrent.historicalGroups.length, 0);
});

test('등록 이후 변경은 마지막 제외·과거 묶기 어느 경로에서도 보정하지 않음', () => {
  const result = estimate(car(['2026-04-02', '2026-04-04', '2026-04-05']), now);
  assert.equal(result.estimatedCount, 3);
  assert.equal(result.currentDealerPurchase, null);
  assert.equal(result.historicalGroups.length, 0);
  assert.equal(estimate(car(['2026-02-20', '2026-04-04']), now).estimatedCount, 2);
});

test('현재 후보와 여러 과거 묶음은 기록을 중복 사용하지 않음', () => {
  const data = car(['2016-01-01', '2016-01-02', '2019-01-01', '2019-02-10', '2026-03-20', '2026-03-26']);
  const result = estimate(data, now);
  assert.equal(result.estimatedCount, 3);
  const used = [result.currentDealerPurchase.originalIndex, ...result.historicalGroups.flatMap(group => group.originalIndexes)];
  assert.equal(new Set(used).size, used.length);
});

test('불완전한 이력·불가능한 날짜·비공개에는 숫자를 추정하지 않음', () => {
  for (const overrides of [
    { ownerHistoryComplete: false }, { ownerChangeCount: null }, { ownerChangeCount: '1' },
    { ownerChangeCount: -1 }, { ownerChangeCount: 2 }, { ownerChanges: null },
    { ownerChanges: ['2026-02-30'] }, { ownerChanges: ['2014-04-13'] },
    { ownerChanges: ['2026-10-04'] }, { ownerChanges: [null] },
    { registDateTime: null }, { registDateTime: '2026-02-30T10:00:00' },
    { registDateTime: '2026-04-03T25:00:00' }, { registDateTime: '2026-04-03T10:00:00+99:00' },
    { registDateTime: '2010-01-01T10:00:00' }, { registDateTime: '2026-10-04T10:00:00' },
    { firstRegistrationDate: null }, { isInsurancePrivate: true }
  ]) {
    const result = estimate(car(['2026-03-26'], overrides), now);
    assert.equal(result.status, 'unavailable', JSON.stringify(overrides));
    assert.equal(result.estimatedCount, null);
    assert.equal(describe(result).text, '딜러 경유 보정: 추정 불가');
  }
  assert.equal(estimate({}, now).status, 'unavailable');
  assert.equal(estimate(car([]), NaN).status, 'unavailable');
  assert.equal(estimate(car([]), now).estimatedCount, 0);
});

test('한국 날짜 기준: 시간대 없는 등록일, UTC·오프셋이 같은 날이면 보정값도 동일', () => {
  for (const registDateTime of ['2026-04-03T00:00:00', '2026-04-03T00:00:00+09:00', '2026-04-02T15:00:00Z', '2026-04-02T11:00:00-04:00']) {
    assert.equal(estimate(car(['2026-04-03'], { registDateTime }), now).estimatedCount, 0);
  }
});

test('추정치 계산 전후의 원본 소유주 점수는 동일 (5회는 그대로 0/15)', () => {
  const scope = vm.createContext({ window: {} });
  vm.runInContext(read('scoring/owner.js'), scope);
  const data = sample();
  const before = scope.window.EncarScoring.scoreOwnerHistory(data, 15);
  assert.equal(estimate(data, now).estimatedCount, 2);
  assert.equal(scope.window.EncarScoring.scoreOwnerHistory(data, 15), before);
  assert.equal(before, 0);
});

test('실제 파서가 등록일·판매자 유형·이력 완전성을 추가 요청 없이 전달', async () => {
  let record = { ownerChangeCnt: 1, ownerChanges: ['2026-03-26'], firstDate: '2014-04-14' };
  const requests = [];
  const scope = vm.createContext({
    console: { log() {}, warn() {} },
    fetch: async url => {
      requests.push(url);
      const body = url.includes('/record/') ? record : url.includes('/readside/vehicle/') ? {
        vehicleId: 41794909, vehicleNo: 'TEST', category: { yearMonth: '201404' },
        manage: { registDateTime: '2026-04-03T14:49:33', firstAdvertisedDateTime: '2026-10-03T21:15:20' },
        contact: { userType: 'DEALER' }
      } : url.includes('/options/') ? [] : {};
      return { ok: true, json: async () => body };
    }
  });
  vm.runInContext(`${read('detail-parser.js')}\nthis.parser = DetailParser;`, scope);
  const data = await scope.parser.fetchDetailData('41794909');
  assert.equal(requests.length, 5);
  assert.equal(data.registDateTime, '2026-04-03T14:49:33');
  assert.equal(data.sellerUserType, 'DEALER');
  assert.equal(data.ownerHistoryComplete, true);
  assert.equal(data.ownerChangeCount, 1);
  assert.equal(estimate(data, now).estimatedCount, 0);
  for (const incomplete of [{ ownerChanges: [] }, { ownerChangeCnt: 0 }, { ownerChangeCnt: 1, ownerChanges: [123] }, null]) {
    record = incomplete;
    assert.equal((await scope.parser.fetchDetailData('41794909')).ownerHistoryComplete, false);
  }
});

/** 배지·툴팁의 실제 생성 경로와 클릭 복사를 검증하는 최소 DOM */
function setupBadge() {
  const created = [];
  let copied = '';
  const element = () => {
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
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const scope = vm.createContext({
    Date: FixedDate, console, location: { pathname: '/list/car' },
    document: { createElement: element, createComment: element, querySelector: () => null, body: element() },
    localStorage: { getItem: () => null }, setTimeout() {},
    navigator: { clipboard: { writeText: async text => { copied = text; } } }
  });
  scope.window = scope;
  const scripts = JSON.parse(read('manifest.json')).content_scripts[0].js;
  for (const file of scripts.filter(file => file !== 'content.js')) vm.runInContext(read(file), scope);
  const content = read('content.js');
  vm.runInContext(content.slice(content.indexOf('  function escapeHtml('), content.indexOf('  function createLoadingBadge(')), scope);
  return { scope, created, copied: () => copied };
}

test('목록·상세 툴팁과 복사에 추정 안내 추가, 원본 횟수·소유 기간·보험 별표는 그대로', async () => {
  for (const pathname of ['/list/car', '/cars/detail/41794909']) {
    const { scope, created, copied } = setupBadge();
    scope.location.pathname = pathname;
    const data = { ...sample(), carId: '41794909', insuranceHistory: [{ date: '2020-04-29', amount: 100000 }] };
    const before = JSON.stringify(data);
    const score = scope.EncarScoring.calculateScore(data);
    const badge = scope.createScoreBadge(score, { carId: '41794909' }, null, data);
    const html = created.find(item => item.className === 'encar-score-tooltip').innerHTML;
    assert.match(html, /소유자 변경: 5회/);
    assert.match(html, /딜러 경유 보정 시 2회 추정/);
    assert.match(html, /원본 이력·점수에는 반영하지 않습니다/);
    assert.equal((html.match(/data-owner-period=/g) || []).length, 6);
    assert.match(html, /data-accident-date="2020-04-29"/);
    assert.equal(score.breakdown.ownerChanges, 0);
    assert.equal(JSON.stringify(data), before);
    badge.events.click({ preventDefault() {}, stopPropagation() {} });
    const menu = created.find(item => item.className === 'encar-action-menu');
    menu.querySelector('[data-action="copy"]').events.click({ stopPropagation() {} });
    await Promise.resolve();
    assert.match(copied(), /소유주변경: 5회/);
    assert.match(copied(), /딜러 경유 보정 시 2회 추정 \(원본 이력·점수 유지\)/);
  }
});
