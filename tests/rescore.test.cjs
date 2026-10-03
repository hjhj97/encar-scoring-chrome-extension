const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const scoringFiles = ['constants.js', 'scoring/grade.js', 'scoring/accident.js', 'scoring/mileage.js', 'scoring/price.js',
  'scoring/inspection.js', 'scoring/rental.js', 'scoring/owner.js', 'scoring/calculator.js'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const content = read('content.js');
const rescoreSource = content.slice(
  content.indexOf('  // 화면에 표시한 매물마다 채점에 쓴 데이터를 기억해 두고,'),
  content.indexOf('  const processedCards = new Set();')
);

// 가격 비중이 큰 차량: 가중치를 바꾸면 점수가 확실히 달라진다
const car = {
  carId: '1', year: 21, month: 3, mileage: 60000, price: 2000, originPrice: 4000,
  accidentAmounts: [], hasInspection: true, hasDiagnosis: true, diagnosisTier: 'BASIC',
  rankCounts: { ONE: { X: 0, W: 0, C: 0 }, TWO: { X: 0, W: 0, C: 0 }, A: { X: 0, W: 0, C: 0 }, B: { X: 0, W: 0, C: 0 } },
  hasRentalHistory: true, ownerChangeCount: 0
};

function setup({ minScore = 0, marketResponses = [], minScoreResponses = [] } = {}) {
  const badges = [];
  const context = vm.createContext({
    console: { log() {}, warn() {} }, Math, Date,
    window: {},
    Event: class { constructor(type) { this.type = type; } },
    createScoreBadge: scoreResult => {
      const badge = {
        score: scoreResult.total, style: { cssText: '' }, isConnected: false,
        dispatchEvent() {},
        replaceWith(next) { this.isConnected = false; next.isConnected = true; }
      };
      badges.push(badge);
      return badge;
    },
    getStoredMinScore: () => minScoreResponses.shift() || Promise.resolve(minScore),
    // 호출 순서대로 준비된 응답을 돌려준다 (없으면 즉시 완료)
    DetailParser: { scoreMarketItems: () => marketResponses.shift() || Promise.resolve({ items: [], scoresLoaded: true }) }
  });
  vm.runInContext(`${scoringFiles.map(read).join('\n')}\nconst EncarScoring = window.EncarScoring;\n${rescoreSource}
    this.renderScoreBadge = renderScoreBadge; this.rescoreAll = rescoreAll; this.scoredEntries = scoredEntries;
    this.W = DEFAULT_WEIGHTS; this.calc = (data, weights) => EncarScoring.calculateScore(data, weights).total;`, context);
  const container = {
    isConnected: true, dataset: {}, style: { display: '' },
    appendChild(badge) { badge.isConnected = true; }
  };
  return { context, badges, container };
}

test('가중치가 바뀌면 이미 표시된 배지를 데이터 재조회 없이 다시 채점한다', async () => {
  const { context, badges, container } = setup();
  const entry = { container, cardData: {}, fullData: car, isDetail: false, badge: null };
  context.renderScoreBadge(entry, context.W);
  context.scoredEntries.add(entry);
  const before = Number(container.dataset.encarScore);
  assert.equal(before, context.calc(car, context.W));

  // 렌트 이력 차량에서 렌트 가중치를 0으로 낮추고 다른 항목을 올리면 점수가 오른다
  const newWeights = { accident: 25, mileage: 15, price: 25, inspection: 20, rental: 0, ownerChanges: 15 };
  await context.rescoreAll(newWeights);
  const after = Number(container.dataset.encarScore);
  assert.equal(after, context.calc(car, newWeights));
  assert.notEqual(after, before);
  assert.equal(entry.badge, badges.at(-1));
  assert.equal(entry.badge.isConnected, true);
  assert.equal(badges[0].isConnected, false); // 이전 배지는 교체됨
});

test('다시 채점한 점수로 최소 점수 필터를 다시 적용한다', async () => {
  const { context, container } = setup({ minScore: 80 });
  const entry = { container, cardData: {}, fullData: car, isDetail: false, badge: null };
  context.renderScoreBadge(entry, context.W);
  context.scoredEntries.add(entry);
  await context.rescoreAll(context.W);
  assert.equal(container.style.display, context.calc(car, context.W) < 80 ? 'none' : '');
  await context.rescoreAll({ accident: 30, mileage: 20, price: 10, inspection: 40, rental: 0, ownerChanges: 0 });
  assert.equal(container.style.display, '');
});

test('늦게 끝난 시세 점수 계산이 새로 그린 배지를 덮어쓰지 않는다', async () => {
  // 처음 가중치의 시세 계산이 다시 채점한 뒤의 계산보다 늦게 끝나는 상황
  let releaseStale, releaseLatest;
  const stale = new Promise(resolve => { releaseStale = resolve; });
  const latest = new Promise(resolve => { releaseLatest = resolve; });
  const { context, container } = setup({ marketResponses: [stale, latest] });
  const fullData = { ...car, marketPriceData: { items: [{ id: '2', price: 1900 }] } };
  const entry = { container, cardData: {}, fullData, isDetail: false, badge: null };
  context.renderScoreBadge(entry, context.W);
  context.scoredEntries.add(entry);
  const latestWeights = { accident: 25, mileage: 15, price: 25, inspection: 20, rental: 0, ownerChanges: 15 };
  assert.notEqual(context.calc(fullData, latestWeights), context.calc(fullData, context.W));
  await context.rescoreAll(latestWeights);

  releaseLatest({ items: [], scoresLoaded: true });
  await new Promise(resolve => setImmediate(resolve));
  releaseStale({ items: [], scoresLoaded: true });
  await new Promise(resolve => setImmediate(resolve));

  // 처음 가중치의 늦은 결과는 버려지고, 마지막 가중치로 그린 배지만 남는다
  assert.equal(entry.badge.isConnected, true);
  assert.equal(entry.badge.score, context.calc(fullData, latestWeights));
});

test('상세 페이지 배지는 고정 위치 스타일을 유지한다', () => {
  const { context, container } = setup();
  const entry = { container, cardData: {}, fullData: car, isDetail: true, badge: null };
  context.renderScoreBadge(entry, context.W);
  assert.match(entry.badge.style.cssText, /position: fixed/);
  assert.equal(container.dataset.encarScore, undefined);
});

test('배점을 연속 저장해도 늦게 완료된 이전 재계산이 최신 점수를 덮지 않는다', async () => {
  let releaseOld;
  const oldFilter = new Promise(resolve => {releaseOld = resolve;});
  const {context, container} = setup({minScoreResponses: [oldFilter, Promise.resolve(0)]});
  const entry = {container, cardData: {}, fullData: car, isDetail: false, badge: null};
  context.renderScoreBadge(entry, context.W);
  context.scoredEntries.add(entry);
  const oldRun = context.rescoreAll(context.W);
  const latest = {accident: 25, mileage: 15, price: 25, inspection: 20, rental: 0, ownerChanges: 15};
  await context.rescoreAll(latest);
  releaseOld(0);
  await oldRun;
  assert.equal(entry.badge.score, context.calc(car, latest));
  assert.equal(Number(container.dataset.encarScore), context.calc(car, latest));
});

test('실제 storage.onChanged 처리기가 저장한 배점을 목록·상세 점수에 전달한다', async () => {
  const {context, container} = setup();
  let storageChanged;
  context.chrome = {storage: {onChanged: {addListener(fn) {storageChanged = fn;}}}};
  const start = content.indexOf('  chrome.storage?.onChanged?.addListener(');
  vm.runInContext(content.slice(start, content.indexOf('  chrome.runtime?.onMessage?', start)), context);
  const list = {container, cardData: {}, fullData: car, isDetail: false, badge: null};
  const detail = {container: {...container, dataset: {}, style: {}}, cardData: {}, fullData: car, isDetail: true, badge: null};
  for (const entry of [list, detail]) {
    context.renderScoreBadge(entry, context.W);
    context.scoredEntries.add(entry);
  }
  const latest = {accident: 25, mileage: 15, price: 25, inspection: 20, rental: 0, ownerChanges: 15};
  storageChanged({weights: {newValue: latest}}, 'local');
  await new Promise(resolve => setImmediate(resolve));
  for (const entry of [list, detail]) assert.equal(entry.badge.score, context.calc(car, latest));
  assert.match(detail.badge.style.cssText, /position: fixed/);
  storageChanged({weights: {newValue: context.W}}, 'sync');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(list.badge.score, context.calc(car, latest));
});
