const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../detail-parser.js'), 'utf8');

function load(fetch) {
  const context = vm.createContext({
    window: {}, fetch, Date, Math, Promise, URL, URLSearchParams, setTimeout,
    console: { log() {}, warn() {} }, DEFAULT_WEIGHTS: {}
  });
  vm.runInContext(`${source}\nthis.DetailParser = DetailParser;`, context);
  return context.DetailParser;
}

const year = new Date().getFullYear() - 3;
// 매물마다 모델 그룹을 달리해 연식별 시세 캐시를 공유하지 않게 한다
const vehicleFor = id => ({
  vehicleId: id, vehicleNo: '12가3456', contact: { userId: `dealer${id}` },
  category: { modelGroupName: `모델${id}`, modelName: `모델${id}`, gradeName: '2.5', yearMonth: `${year}03`, formYear: String(year) },
  spec: {}, advertisement: { price: 5000 }, condition: { accident: { recordView: false } }
});
const searchResult = { Count: 1, SearchResults: [{ Id: 999, Price: 5000, Year: `${year}03`, Model: '모델', Badge: '2.5' }] };
const json = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('검색 요청은 동시에 2개까지만, 출발 간격은 0.45초 이상으로 보낸다', async () => {
  const startTimes = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let searches = 0;
  const parser = load(async url => {
    const id = Number(url.match(/vehicle\/(\d+)/)?.[1]);
    if (url.includes('/readside/vehicle/')) return json(vehicleFor(id));
    if (url.includes('/search/')) {
      searches++;
      startTimes.push(Date.now());
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await wait(5);
      inFlight--;
      return json(searchResult);
    }
    return json(null, 404);
  });
  // 배지용 조회와 툴팁용 조회(동급 시세·딜러 평균)를 함께 일으켜 검색을 몰리게 한다
  const results = await Promise.all([1, 2, 3].map(async id => {
    const data = await parser.fetchDetailData(id);
    await parser.fetchTooltipExtras(id, data.dealerUserId);
    return data;
  }));
  assert.ok(searches >= 6, `검색 ${searches}건`);
  assert.ok(maxInFlight <= 2, `동시 ${maxInFlight}건`);
  assert.equal(results.length, 3);
  // 검색 출발 간격은 0.45초 이상 (엔카 검색 API 속도 제한 아래로 유지)
  const gaps = startTimes.slice(1).map((at, i) => at - startTimes[i]);
  assert.ok(gaps.every(gap => gap >= 440), `최소 간격 ${Math.min(...gaps)}ms`);
});

test('검색이 429를 받으면 다른 검색도 대기 시간이 끝날 때까지 보내지 않고, 이후 재시도로 성공한다', async () => {
  const starts = [];
  let first429At = null;
  const parser = load(async url => {
    const id = Number(url.match(/vehicle\/(\d+)/)?.[1]);
    if (url.includes('/readside/vehicle/')) return json(vehicleFor(id));
    if (url.includes('/search/')) {
      const now = Date.now();
      starts.push(now);
      if (first429At === null) {
        first429At = now;
        return { ok: false, status: 429, headers: { get: name => (name === 'Retry-After' ? '0.3' : null) }, json: async () => ({}) };
      }
      return json(searchResult);
    }
    return json(null, 404);
  });
  const results = await Promise.all([1, 2, 3].map(async id => {
    const data = await parser.fetchDetailData(id);
    await parser.fetchTooltipExtras(id, data.dealerUserId);
    return data;
  }));
  // 첫 429 이후 0.3초(Retry-After) 동안에는 어떤 검색도 새로 출발하지 않는다
  const startedDuringPause = starts.filter(at => at > first429At && at < first429At + 290);
  assert.deepEqual(startedDuringPause, []);
  assert.ok(starts.length > 1);
  assert.ok(results.every((data, i) => data.dealerUserId === `dealer${i + 1}`)); // 기본값이 아닌 실제 데이터로 끝남
});

test('배지용 조회는 연식별 시세 검색 1건만 보내고, 툴팁용 조회는 처음 열 때 한 번만 받는다', async () => {
  const searchUrls = [];
  let vehicleCalls = 0;
  const parser = load(async url => {
    if (url.includes('/readside/vehicle/')) {
      vehicleCalls++;
      return json(vehicleFor(Number(url.match(/vehicle\/(\d+)/)[1])));
    }
    if (url.includes('/search/')) {
      searchUrls.push(decodeURIComponent(url));
      return json(searchResult);
    }
    return json(null, 404);
  });
  const data = await parser.fetchDetailData(7);
  assert.equal(searchUrls.length, 1);
  assert.doesNotMatch(searchUrls[0], /UserId|Year\.range/); // 딜러·동급 시세 검색 없음
  assert.equal(data.marketPriceData, null);
  assert.equal(data.dealerAvgScore, null);
  assert.equal(data.dealerUserId, 'dealer7');

  const extras = await parser.fetchTooltipExtras(7, data.dealerUserId);
  assert.ok(searchUrls.some(url => url.includes('UserId.dealer7')));
  assert.ok(searchUrls.some(url => url.includes('Year.range')));
  assert.ok('marketPriceData' in extras && 'dealerAvgScore' in extras);

  // 다시 열어도 같은 결과를 캐시에서 쓰고, 차량 기본 정보도 다시 받지 않는다
  const searchesBefore = searchUrls.length;
  const vehicleCallsForCar7 = vehicleCalls;
  await parser.fetchTooltipExtras(7, data.dealerUserId);
  assert.equal(searchUrls.length, searchesBefore);
  assert.equal(vehicleCalls, vehicleCallsForCar7);
});
