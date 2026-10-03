const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const scoringFiles = ['constants.js', 'scoring/grade.js', 'scoring/accident.js', 'scoring/mileage.js', 'scoring/price.js',
  'scoring/inspection.js', 'scoring/rental.js', 'scoring/owner.js', 'scoring/calculator.js'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// 실제 record API 응답 형식 (전손·침수 이력이 없는 매물은 0 / null)
const cleanRecord = {
  openData: true, accidentCnt: 0, myAccidentCnt: 0, myAccidentCost: 0, otherAccidentCnt: 0, otherAccidentCost: 0,
  ownerChangeCnt: 1, totalLossCnt: 0, totalLossDate: null, floodTotalLossCnt: 0, floodPartLossCnt: null, floodDate: null,
  robberCnt: 0, robberDate: null
};

/** 저장된 API 응답 형식으로 detail-parser를 실제로 돌려 파싱 결과와 점수를 얻는다. */
async function parse({ record = cleanRecord, recordView = true, waterlog = false } = {}) {
  const vehicle = {
    vehicleId: 1, vehicleNo: '12가3456',
    category: { modelGroupName: '쏘나타', modelName: 'YF 쏘나타', gradeName: 'Y20', yearMonth: '201101', originPrice: 2547 },
    condition: { accident: { recordView }, inspection: { formats: ['TABLE'] } },
    advertisement: { price: 330 }, spec: { mileage: 163851 }, contact: {}, manage: {}, partnership: {}
  };
  const responses = [
    ['/inspection/', { master: { accdient: false, simpleRepair: false, detail: { waterlog } }, outers: [] }],
    ['/diagnosis/', {}], ['/record/', record], ['/options/', []], ['/search/', { Count: 0, SearchResults: [] }],
    ['/readside/vehicle/', vehicle]
  ];
  const fetch = async url => {
    const body = responses.find(([part]) => String(url).includes(part))?.[1] ?? {};
    return { ok: true, status: 200, json: async () => body };
  };
  const context = vm.createContext({ window: {}, console: { log() {}, warn() {} }, fetch, Math, Date, encodeURIComponent, setTimeout,
    chrome: { runtime: { sendMessage() {} } } });
  vm.runInContext(`${scoringFiles.map(read).join('\n')}\n${read('detail-parser.js')}
    this.DetailParser = DetailParser; this.ns = window.EncarScoring; this.W = DEFAULT_WEIGHTS;`, context);
  const data = await context.DetailParser.fetchDetailData('1');
  const result = context.ns.calculateScore(data, context.W);
  return { data, result, penaltyKeys: [...result.penalties].map(item => item.key), hasFlag: context.ns.hasTotalLossOrFlood(data) };
}

test('전손·침수 이력이 없으면 페널티 없음 (floodPartLossCnt가 null이어도)', async () => {
  const { data, penaltyKeys, hasFlag } = await parse();
  assert.equal(data.totalLossCount, 0);
  assert.equal(data.floodPartLossCount, 0);
  assert.equal(hasFlag, false);
  assert.deepEqual(penaltyKeys, []);
});

test('보험이력의 전손·침수 기록이 있으면 종합점수 30점 감점', async () => {
  const clean = await parse();
  for (const record of [
    { ...cleanRecord, totalLossCnt: 1, totalLossDate: '2019-05-26' },
    { ...cleanRecord, floodTotalLossCnt: 1, floodDate: '2020-08-10' },
    { ...cleanRecord, floodPartLossCnt: 2, floodDate: '2020-08-10' }
  ]) {
    const { data, result, penaltyKeys } = await parse({ record });
    assert.deepEqual(penaltyKeys, ['totalLossFlood']);
    assert.equal(clean.result.total - result.total, 30);
    assert.equal(data.totalLossDate ?? data.floodDate, record.totalLossDate ?? record.floodDate);
  }
});

test('전손과 침수가 함께 있어도 한 번만 감점, 다른 페널티와는 합산', async () => {
  const both = await parse({ record: { ...cleanRecord, totalLossCnt: 1, floodTotalLossCnt: 1, floodPartLossCnt: 1 } });
  assert.deepEqual(both.penaltyKeys, ['totalLossFlood']);
  assert.equal(both.result.penalty, 30);
});

test('성능점검표 침수 표시만 있어도 전손·침수로 감점', async () => {
  const { data, penaltyKeys } = await parse({ waterlog: true });
  assert.equal(data.inspectionFlood, true);
  assert.deepEqual(penaltyKeys, ['totalLossFlood']);
});

test('보험이력 비공개면 전손·침수는 알 수 없으므로 비공개 페널티만 적용', async () => {
  const { data, penaltyKeys } = await parse({ recordView: false });
  assert.equal(data.isInsurancePrivate, true);
  assert.equal(data.totalLossCount, 0);
  assert.deepEqual(penaltyKeys, ['private']);
});
