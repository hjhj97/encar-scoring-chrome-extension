const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../detail-parser.js'), 'utf8');

function load(fetch) {
  const context = vm.createContext({
    window: {}, fetch, Date, Math, Promise, URL, URLSearchParams,
    setTimeout: (fn) => setTimeout(fn, 0), console: { log() {}, warn() {} }, DEFAULT_WEIGHTS: {}
  });
  vm.runInContext(`${source}\nthis.DetailParser = DetailParser;`, context);
  return context.DetailParser;
}

const year = new Date().getFullYear() - 3;
const vehicle = { vehicleId: 1, vehicleNo: '12가3456', category: { modelGroupName: 'GV80', modelName: 'GV80', gradeName: '가솔린 2.5T' },
  spec: {}, advertisement: { price: 5000 }, condition: { accident: { recordView: false } } };
const search = { Count: 2, SearchResults: [
  { Id: 1, Price: 5000, Year: `${year}03`, Model: 'GV80', Badge: '가솔린 2.5T' },
  { Id: 2, Price: 6000, Year: `${year}05`, Model: 'GV80', Badge: '가솔린 2.5T' }
] };
const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test('연식별 시세: 429는 재시도해 가격 기준을 얻는다', async () => {
  let searchCalls = 0;
  const parser = load(async (url) => {
    if (url.includes('/vehicle/')) return json(vehicle);
    if (url.includes('search/car/list')) return ++searchCalls === 1 ? json(null, 429) : json(search);
    return json(null, 404);
  });
  const data = await parser.fetchDetailData(1);
  assert.equal(data.yearlyMarketData?.points?.[0]?.avgPrice, 5500);
});

test('연식별 시세: 실패 결과는 캐시하지 않아 다음 매물에서 다시 조회한다', async () => {
  let fail = true;
  const parser = load(async (url) => {
    if (url.includes('/vehicle/')) return json(vehicle);
    if (url.includes('search/car/list')) return fail ? json(null, 500) : json(search);
    return json(null, 404);
  });
  assert.equal((await parser.fetchDetailData(1)).yearlyMarketData, null);
  fail = false;
  assert.equal((await parser.fetchDetailData(2)).yearlyMarketData?.points?.[0]?.avgPrice, 5500);
});
