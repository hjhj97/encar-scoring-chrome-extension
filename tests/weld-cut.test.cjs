const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const scoringFiles = ['constants.js', 'scoring/grade.js', 'scoring/accident.js', 'scoring/mileage.js', 'scoring/price.js',
  'scoring/inspection.js', 'scoring/rental.js', 'scoring/owner.js', 'scoring/calculator.js'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// 매물 42635004(BMW 640d)의 실제 성능점검표: 양쪽 쿼터 패널 용접·절단 + 앞문 판금
const weldCutOuters = [
  { type: { code: 'P062', title: '쿼터 패널(우)' }, statusTypes: [{ code: 'W', title: '판금/용접' }, { code: 'WC', title: '용접,절단' }], attributes: ['RANK_TWO'] },
  { type: { code: 'P031', title: '프론트 도어(좌)' }, statusTypes: [{ code: 'W', title: '판금/용접' }], attributes: ['RANK_ONE'] },
  { type: { code: 'P061', title: '쿼터 패널(좌)' }, statusTypes: [{ code: 'W', title: '판금/용접' }, { code: 'WC', title: '용접,절단' }], attributes: ['RANK_TWO'] }
];

/** 저장된 API 응답으로 detail-parser를 실제로 돌려 파싱 결과를 얻는다. 시세·딜러·보험 조회는 빈 응답. */
async function parse(outers) {
  const vehicle = {
    vehicleId: 1, vehicleNo: '12가3456',
    category: { modelGroupName: '6시리즈', modelName: '6시리즈 (F12)', gradeName: '640d', yearMonth: '201606', originPrice: 11610 },
    condition: { accident: { recordView: true }, inspection: { formats: ['TABLE'] } },
    advertisement: { price: 2180 }, spec: { mileage: 76179 }, contact: {}, manage: {}, partnership: {}
  };
  const responses = [
    ['/inspection/', { master: { accdient: true, simpleRepair: true }, outers }],
    ['/diagnosis/', {}], ['/record/', null], ['/options/', []], ['/search/', { Count: 0, SearchResults: [] }],
    ['/readside/vehicle/', vehicle]
  ];
  const fetch = async url => {
    const body = responses.find(([part]) => String(url).includes(part))?.[1] ?? {};
    return body === null ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => body };
  };
  const context = vm.createContext({ window: {}, console: { log() {}, warn() {} }, fetch, Math, Date, encodeURIComponent, setTimeout,
    chrome: { runtime: { sendMessage() {} } } });
  vm.runInContext(`${scoringFiles.map(read).join('\n')}\n${read('detail-parser.js')}\nthis.DetailParser = DetailParser;`, context);
  return context.DetailParser.fetchDetailData('1');
}

function scorer() {
  const context = vm.createContext({ window: {}, console: { log() {} }, Math, Date });
  vm.runInContext(`${scoringFiles.map(read).join('\n')}\nthis.ns = window.EncarScoring; this.W = DEFAULT_WEIGHTS;`, context);
  return context;
}

test('성능점검표의 용접·절단(WC) 부위를 찾아 판금으로도 센다', async () => {
  const data = await parse(weldCutOuters);
  assert.equal(data.hasWeldCut, true);
  assert.deepEqual([...data.weldCutParts], ['쿼터 패널(우)', '쿼터 패널(좌)']);
  assert.equal(data.rankCounts.TWO.W, 2);
  assert.equal(data.rankCounts.ONE.W, 1);

  // WC만 단독으로 기록된 부위도 판금으로 센다 (이전에는 누락)
  const onlyWc = await parse([{ type: { title: '사이드실 패널(우)' }, statusTypes: [{ code: 'WC' }], attributes: ['RANK_TWO'] }]);
  assert.equal(onlyWc.hasWeldCut, true);
  assert.equal(onlyWc.hasWelding, true);
  assert.equal(onlyWc.rankCounts.TWO.W, 1);

  const clean = await parse([{ type: { title: '프론트 도어(좌)' }, statusTypes: [{ code: 'W' }], attributes: ['RANK_ONE'] }]);
  assert.equal(clean.hasWeldCut, false);
  assert.deepEqual([...clean.weldCutParts], []);
});

test('용접·절단이 있으면 종합점수에서 부위 수와 관계없이 30점을 한 번 감점', () => {
  const { ns, W } = scorer();
  const car = {
    year: 16, month: 6, mileage: 76179, price: 2180, originPrice: 11610, accidentAmounts: [],
    hasInspection: true, hasDiagnosis: false,
    rankCounts: { ONE: { X: 0, W: 1, C: 0 }, TWO: { X: 0, W: 2, C: 0 }, A: { X: 0, W: 0, C: 0 }, B: { X: 0, W: 0, C: 0 } }
  };
  const without = ns.calculateScore({ ...car, hasWeldCut: false }, W);
  const withCut = ns.calculateScore({ ...car, hasWeldCut: true, weldCutParts: ['쿼터 패널(우)', '쿼터 패널(좌)'] }, W);
  assert.equal(without.total - withCut.total, 30);
  assert.equal(withCut.penalty, 30);
  assert.deepEqual([...withCut.penalties].map(item => [item.key, item.points]), [['weldCut', 30]]);
  assert.deepEqual([...without.penalties].map(item => item.key), []);

  // 비공개 페널티와 함께 적용되고 0점 아래로 내려가지 않는다
  const both = ns.calculateScore({ ...car, hasWeldCut: true, isInsurancePrivate: true }, W);
  assert.equal(both.penalty, 70);
  assert.deepEqual([...both.penalties].map(item => item.key), ['private', 'weldCut']);
  assert.ok(both.total >= 0);
});
