const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../depreciation.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const barSource = contentSource.slice(
  contentSource.indexOf('  function createDepreciationBar('),
  contentSource.indexOf('  function createYearlyMarketChart(')
);

function load(extra = {}) {
  const context = vm.createContext({ console: { log() {}, warn() {} }, Date, Math, setTimeout, ...extra });
  vm.runInContext(`${source}\nthis.EncarDepreciation = EncarDepreciation;`, context);
  return context.EncarDepreciation;
}

// 재현 가능한 난수 (mulberry32 + Box-Muller)
function random(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}

// 정답 곡선: 8년까지 연 7%, 이후 연 12% (log 기울기), 1만km당 3.5%
const TRUE_SLOPE = age => (age < 8 ? -0.07 : -0.12);
const TRUE_KM = -0.035;
const trueLog = age => {
  let value = 0;
  for (let a = 0; a < age; a += 0.01) value += TRUE_SLOPE(a) * Math.min(0.01, age - a);
  return value;
};

function synthetic({ n = 1500, seed = 1, groups = 20, noise = 0.08, outlierRate = 0, bump = false } = {}) {
  const rng = random(seed);
  const levels = Array.from({ length: groups }, () => Math.log(1500 + rng.uniform() * 4000));
  return Array.from({ length: n }, (_, i) => {
    const group = i % groups;
    const age = 0.5 + rng.uniform() * 13.5;
    // 실제 매물처럼 차량마다 연간 주행 패턴이 다르다(연 1.3만km 중심, 로그정규).
    // 주행 패턴 차이가 없으면 연식·주행 효과를 나눌 수 없다.
    const km = age * 1.3 * Math.exp(rng.normal() * 0.4);
    let logPrice = levels[group] + trueLog(age) + TRUE_KM * km + rng.normal() * noise;
    if (bump && age > 5 && age < 6) logPrice += 0.25; // 오래될수록 비싸지는 구간
    if (rng.uniform() < outlierRate) logPrice += Math.log(3);
    return { group: `모델::${group}`, age, km, logPrice };
  });
}

const pureRate = (D, curve, age) => 1 - Math.exp(D.curveLogValue(curve, age + 1) - D.curveLogValue(curve, age));
const truePureRate = age => 1 - Math.exp(trueLog(age + 1) - trueLog(age));

test('정답 곡선과 주행거리 효과를 복원', () => {
  const D = load();
  const curve = D.fitCurve(synthetic());
  assert.ok(curve);
  for (const age of [2, 5, 10]) {
    assert.ok(Math.abs(pureRate(D, curve, age) - truePureRate(age)) < 0.015, `${age}년 연식 감가`);
    // 화면에 표시하는 총 감가율(연식 + 연 1.3만km 주행)
    const total = D.estimate(curve, { age, mileage: age * 13000, price: 1000 }).totalRate;
    const trueTotal = 1 - (1 - truePureRate(age)) * Math.exp(TRUE_KM * 1.3);
    assert.ok(Math.abs(total - trueTotal) < 0.01, `${age}년 총 감가`);
  }
  assert.ok(Math.abs(curve.mileageCoef - TRUE_KM) < 0.005);
  assert.ok(Math.abs(curve.typicalKmPerYear - 1.3) < 0.1);
});

test('가격이 오르는 구간이 있어도 곡선은 단조 감소', () => {
  const D = load();
  const curve = D.fitCurve(synthetic({ bump: true, seed: 2 }));
  assert.ok(curve.slopes.every(slope => slope <= 1e-12));
  assert.ok(curve.mileageCoef <= 1e-12);
});

test('상담가·이상치 5%에도 추정이 크게 흔들리지 않음', () => {
  const D = load();
  const clean = D.fitCurve(synthetic({ seed: 3 }));
  const noisy = D.fitCurve(synthetic({ seed: 3, outlierRate: 0.05 }));
  for (const age of [2, 5, 10]) {
    assert.ok(Math.abs(pureRate(D, noisy, age) - pureRate(D, clean, age)) < 0.02, `${age}년`);
  }
});

test('표본·연식 범위가 부족하면 추정하지 않음', () => {
  const D = load();
  assert.equal(D.fitCurve(synthetic({ n: 100 })), null);
  assert.match(D.insufficiencyReason(synthetic({ n: 100 })), /표본 부족 \(100대, 최소 150대\)/);
  const narrow = synthetic({ seed: 4 }).map(row => ({ ...row, age: 3 + (row.age % 2) }));
  assert.equal(D.fitCurve(narrow), null);
  assert.match(D.insufficiencyReason(narrow), /연식 범위 부족/);
  // 그룹당 5대 미만인 트림은 제외 후 판단
  const sparse = synthetic({ n: 400, groups: 200 });
  assert.equal(D.fitCurve(sparse), null);
  assert.match(D.insufficiencyReason(sparse), /표본 부족 \(0대/);
  assert.equal(D.insufficiencyReason(synthetic()), null);
});

test('매물 필터: 렌트·리스·중복·상담가·잘못된 연식 제외', () => {
  const D = load();
  const now = new Date(2026, 8, 15); // 2026년 9월
  const base = { Model: '더 뉴 그랜저 IG', Badge: '2.5 ', Year: 202203.0, Mileage: 45000, Price: 2400, SellType: '일반' };
  const parsed = D.parseListing(base, now);
  assert.equal(parsed.group, '더 뉴 그랜저 IG::2.5');
  assert.ok(Math.abs(parsed.age - (4 + 6 / 12)) < 1e-9);
  assert.equal(parsed.km, 4.5);
  assert.equal(D.parseListing({ ...base, SellType: '렌트' }, now), null);
  assert.equal(D.parseListing({ ...base, SellType: '리스' }, now), null);
  assert.equal(D.parseListing({ ...base, LeaseType: 'X' }, now), null);
  assert.equal(D.parseListing({ ...base, ServiceCopyCar: 'DUPLICATION' }, now), null);
  assert.equal(D.parseListing({ ...base, Price: 9999 }, now), null);
  assert.equal(D.parseListing({ ...base, Year: 202213 }, now), null);
  assert.equal(D.parseListing({ ...base, Year: 202712 }, now), null);
});

test('이 차량 추정: 모델 전형 주행 가정, 연식·주행 분해, 범위 밖 표시', () => {
  const D = load();
  const curve = D.fitCurve(synthetic({ seed: 5 }));
  const normal = D.estimate(curve, { age: 5, price: 2000 });
  // 과거 주행이 많은 차도 앞으로의 주행은 모델 전형값으로 가정한다.
  const heavy = D.estimate(curve, { age: 5, mileage: 150000, price: 2000 });
  assert.equal(normal.kmPerYear, curve.typicalKmPerYear);
  assert.equal(heavy.totalRate, normal.totalRate);
  assert.ok(Math.abs(normal.totalRate - (1 - (1 - normal.ageRate) * (1 - normal.mileageRate))) < 1e-9);
  assert.ok(Math.abs(normal.yearLoss - 2000 * normal.totalRate) < 1e-9);
  assert.equal(normal.extrapolated, false);
  assert.equal(D.estimate(curve, { age: 16, price: 500 }).extrapolated, true);
  assert.equal(D.estimate(curve, { age: NaN, price: 500 }), null);
  assert.equal(D.estimate(null, { age: 3, price: 500 }), null);
});

test('차트 곡선 수준을 연식별 평균가에 맞춤', () => {
  const D = load();
  const curve = D.fitCurve(synthetic({ seed: 6 }));
  const shift = 0.2;
  const level = Math.log(3000);
  const expected = age => Math.exp(level + D.curveLogValue(curve, age) + curve.mileageCoef * curve.typicalKmPerYear * age);
  const points = [1, 3, 5, 7].map(age => ({ age, avgPrice: expected(age + shift), count: 10 }));
  const priceAt = D.fitLevelToPoints(curve, [...points, { age: 2, avgPrice: NaN, count: 3 }], shift);
  for (const point of points) assert.ok(Math.abs(priceAt(point.age + shift) / point.avgPrice - 1) < 1e-9);
  assert.equal(D.fitLevelToPoints(curve, [], shift), null);
});

test('모델 그룹 조회: 최대 4회 요청, 캐시 재사용, 마침표 모델 그룹 거부', async () => {
  const rows = synthetic({ n: 2000, seed: 7 }).map((row, i) => {
    const year = 2026 - Math.floor(row.age);
    return { Model: '모델', Badge: row.group, Year: year * 100 + 1 + (i % 12), Mileage: row.km * 10000,
      Price: Math.min(9000, Math.exp(row.logPrice)), SellType: '일반' };
  });
  const urls = [];
  const stored = {};
  const D = load({
    fetch: async url => {
      urls.push(url);
      const offset = Number(decodeURIComponent(url).match(/\|ModifiedDate\|(\d+)\|/)[1]);
      return { ok: true, json: async () => ({ Count: 5000, SearchResults: rows.slice(offset, offset + 500) }) };
    },
    chrome: { storage: { local: {
      get: async keys => Object.fromEntries(keys.filter(key => key in stored).map(key => [key, stored[key]])),
      set: value => Object.assign(stored, value)
    } } }
  });
  const first = await D.fetchCurve('테스트');
  assert.ok(first.curve);
  // 표본 500대 이상이면 부트스트랩 범위를 만들지 않는다.
  assert.equal(first.curve.bootstrap, undefined);
  assert.equal(urls.length, 4);
  assert.ok(urls[0].includes(encodeURIComponent('테스트')));
  await D.fetchCurve('테스트');
  assert.equal(urls.length, 4);
  assert.ok(Object.keys(stored).some(key => key.includes('테스트')));

  const blocked = await D.fetchCurve('3.0 그룹');
  assert.equal(blocked.curve, null);
  assert.equal(urls.length, 4);
});

test('연식별 차트: 추정 곡선·현재 차량 점 렌더링, NaN 없음', () => {
  const content = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const chartSource = content.slice(content.indexOf('function createYearlyMarketChart'), content.indexOf('  function createScoreBadge'));
  const context = vm.createContext({ Date, Math, Number, Array, Map, String });
  vm.runInContext(`${chartSource}\nthis.createYearlyMarketChart = createYearlyMarketChart;`, context);
  const yearly = { points: [0, 1, 2, 3, 4, 5].map(age => ({ age, year: 2026 - age, count: 5 + age, avgPrice: 3000 - age * 250 })) };

  const plain = context.createYearlyMarketChart(yearly, 22, 3800);
  assert.doesNotMatch(plain, /추정곡선/);

  const withCurve = context.createYearlyMarketChart(yearly, 22, 3800, {
    priceAt: age => 3050 * Math.exp(-0.08 * age), ageShift: 0.2, carAge: 4.2, carPrice: 2400
  });
  assert.match(withCurve, /추정곡선/);
  assert.match(withCurve, /stroke-dasharray="3 2"/);
  assert.match(withCurve, /이 차량 2,400만원/);
  assert.doesNotMatch(withCurve, /NaN|undefined|Infinity/);
});

test('표본 500대 미만: 부트스트랩 90% 범위 제공, 같은 표본이면 같은 결과', async () => {
  const rows = synthetic({ n: 250, seed: 8 }).map((row, i) => {
    const year = 2026 - Math.floor(row.age);
    return { Model: '모델', Badge: row.group, Year: year * 100 + 1 + (i % 12), Mileage: row.km * 10000,
      Price: Math.min(9000, Math.exp(row.logPrice)), SellType: '일반' };
  });
  const urls = [];
  const stored = {};
  const D = load({
    fetch: async url => {
      urls.push(url);
      return { ok: true, json: async () => ({ Count: rows.length, SearchResults: rows }) };
    },
    chrome: { storage: { local: {
      get: async keys => Object.fromEntries(keys.filter(key => key in stored).map(key => [key, stored[key]])),
      set: value => Object.assign(stored, value)
    } } }
  });
  const { curve } = await D.fetchCurve('소형');
  assert.equal(urls.length, 1); // 500대 미만이면 한 번만 요청
  assert.ok(curve.sampleCount < 500);
  assert.ok(curve.bootstrap.length >= 30);
  assert.ok(Object.values(stored)[0].curve.bootstrap.length >= 30);

  const result = D.estimate(curve, { age: 5, price: 2000 });
  const [low, high] = result.rateRange;
  assert.ok(low < result.totalRate && result.totalRate < high);
  assert.ok(high - low > 0.002 && high - low < 0.1);

  const listings = rows.map(row => D.parseListing(row)).filter(Boolean);
  const again = await D.bootstrapCurves(listings);
  assert.deepEqual(again.map(c => c.mileageCoef), curve.bootstrap.map(c => c.mileageCoef));
});

test('감가 4단계 경계 (신차가 대비 연 감가)', () => {
  const D = load();
  assert.equal(D.rateLevel(0.09).label, '가파른 감가');
  assert.equal(D.rateLevel(0.065).key, 'steep');
  assert.equal(D.rateLevel(0.0649).key, 'average');
  assert.equal(D.rateLevel(0.04).key, 'average');
  assert.equal(D.rateLevel(0.0399).key, 'gentle');
  assert.equal(D.rateLevel(0.025).key, 'gentle');
  assert.equal(D.rateLevel(0.0249).label, '감가 둔화');
  assert.equal(D.rateLevel(0).key, 'flat');

  const curve = D.fitCurve(synthetic({ seed: 9 }));
  // 15년 넘은 저가 차량: 현재가 대비 감가율은 커도 신차가 대비로는 감가 둔화
  const old = D.estimate(curve, { age: 15.8, price: 330, originPrice: 2547 });
  assert.ok(old.totalRate > 0.05);
  assert.ok(Math.abs(old.originRate - old.totalRate * 330 / 2547) < 1e-12);
  assert.ok(Math.abs(old.originRate - old.yearLoss / 2547) < 1e-12);
  assert.equal(old.level.key, D.rateLevel(old.originRate).key);
  // 신차가가 없으면 단계를 판정하지 않는다.
  const noOrigin = D.estimate(curve, { age: 5, price: 1000 });
  assert.equal(noOrigin.originRate, null);
  assert.equal(noOrigin.level, null);
  assert.equal(noOrigin.originRateRange, null);
});

async function renderDepreciation({ fetchResult, fetchError, modelGroupName = '그랜저', originPrice = 3800 }) {
  const content = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const loader = content.slice(content.indexOf('    let depreciationLoadStarted = false;'), content.indexOf('    let activityLoading = false;'));
  const elements = {};
  const context = vm.createContext({
    console: { log() {}, warn() {} }, Date, Math, setTimeout,
    tooltip: { querySelector: selector => (selector.startsWith('[') ? (elements[selector] ||= {}) : null) },
    fullData: { modelGroupName, yearlyMarketData: null },
    canShowDepreciation: true, carAgeYears: 5, price: 2000, year: 21, originPrice, nowMonth: 9,
    depreciationTotalText: '신차가 3,800만원 → 2,000만원 · 누적 47% 감가',
    clipboardExtras: {}, refreshClipboardText() {}, requestAnimationFrame() {}, positionTooltip() {},
    fetchResult, fetchError
  });
  vm.runInContext(`${source}\n${barSource}
    EncarDepreciation.fetchCurve = async () => { if (fetchError) throw fetchError; return fetchResult; };
    ${loader}
    this.done = loadDepreciation();`, context);
  await context.done;
  const text = selector => elements[selector]?.textContent || '';
  return {
    level: text('[data-encar-depreciation-level]'),
    forecast: text('[data-encar-depreciation-forecast]'),
    title: elements['[data-encar-depreciation-forecast]']?.title || '',
    levelClass: elements['[data-encar-depreciation-level]']?.className || '',
    bar: elements['[data-encar-depreciation-bar]']?.innerHTML || '',
    clipboard: context.clipboardExtras.depreciation || ''
  };
}

test('툴팁: 감가 막대 아래에 1년 예상 감가액·예상가 표시, 근거와 복사 내용 유지', async () => {
  const D = load();
  const curve = D.fitCurve(synthetic({ seed: 10 }));
  const expected = D.estimate(curve, { age: 5, price: 2000, originPrice: 3800 });

  const ok = await renderDepreciation({ fetchResult: { curve, reason: null } });
  const loss = Math.round(expected.yearLoss);
  assert.equal(ok.level, expected.level.label);
  assert.equal(ok.forecast, `1년 예상 감가 ${loss.toLocaleString()}만원 · 1년 후 예상가 ${(2000 - loss).toLocaleString()}만원 ⓘ`);
  assert.doesNotMatch(ok.forecast, /신차가 100% 기준/);
  assert.ok(ok.title.startsWith(`1년 후 예상가 ${(2000 - loss).toLocaleString()}만원 (-${loss.toLocaleString()}만원, 신차가 대비 ${(expected.originRate * 100).toFixed(1)}%)`));
  assert.match(ok.bar, /data-depreciation-part="forecast"/);
  assert.match(ok.levelClass, new RegExp(`encar-depreciation-level--${expected.level.key}`));
  assert.match(ok.title, /현재가 대비 [\d.]+% \(연식 [\d.]+% \+ 주행 [\d.]+%\)\n그랜저 매물 [\d,]+대 회귀/);
  assert.match(ok.clipboard, new RegExp(`현재 감가: ${expected.level.label} · 1년 후 예상가 [\\d,]+만원 \\(-[\\d,]+만원, 신차가 대비 [\\d.]+%\\) · 현재가 대비`));

  const small = await renderDepreciation({ fetchResult: { curve: { ...curve, bootstrap: [curve, curve] }, reason: null } });
  assert.match(small.title, /· 90% 범위 신차가 대비 [\d.]+%~[\d.]+%\n/);

  // 신차가가 없으면 단계 없이 예상가·하락액만 표시
  const noOrigin = await renderDepreciation({ fetchResult: { curve, reason: null }, originPrice: 0 });
  assert.equal(noOrigin.level, '신차가 정보 없음');
  assert.equal(noOrigin.forecast, `1년 예상 감가 ${loss.toLocaleString()}만원 · 1년 후 예상가 ${(2000 - loss).toLocaleString()}만원 ⓘ`);
  assert.match(noOrigin.levelClass, /--none/);
  assert.match(noOrigin.bar, /신차가 정보 없음 · 비율 표시 불가/);
  assert.doesNotMatch(noOrigin.bar, /data-depreciation-part/);

  const insufficient = await renderDepreciation({ fetchResult: { curve: null, reason: '표본 부족 (98대, 최소 150대)' } });
  assert.equal(insufficient.level, '추정 불가');
  assert.equal(insufficient.forecast, '표본 부족 (98대, 최소 150대)');
  assert.match(insufficient.levelClass, /--none/);
  assert.match(insufficient.bar, /data-depreciation-part="retained"/);
  assert.match(insufficient.bar, /data-depreciation-part="past"/);
  assert.doesNotMatch(insufficient.bar, /data-depreciation-part="forecast"/);

  const failed = await renderDepreciation({ fetchError: new Error('HTTP 429') });
  assert.equal(failed.level, '조회 실패');
  assert.match(failed.bar, /data-depreciation-part="past"/);
  assert.doesNotMatch(failed.bar, /data-depreciation-part="forecast"/);

  const noModel = await renderDepreciation({ modelGroupName: '' });
  assert.equal(noModel.level, '추정 불가');
  assert.equal(noModel.forecast, '모델 정보 없음');
});

test('매물 조회: 429·네트워크 오류는 재시도, 4xx는 즉시 실패', async () => {
  const rows = synthetic({ n: 400, seed: 11 }).map((row, i) => ({
    Model: '모델', Badge: row.group, Year: (2026 - Math.floor(row.age)) * 100 + 1 + (i % 12),
    Mileage: row.km * 10000, Price: Math.min(9000, Math.exp(row.logPrice)), SellType: '일반'
  }));
  const responses = [
    () => ({ ok: false, status: 429, headers: { get: () => '1' } }),
    () => { throw new TypeError('Failed to fetch'); },
    () => ({ ok: true, json: async () => ({ Count: rows.length, SearchResults: rows }) })
  ];
  let calls = 0;
  const waits = [];
  const D = load({
    setTimeout: (fn, ms) => { waits.push(ms); fn(); },
    fetch: async () => responses[Math.min(calls++, responses.length - 1)]()
  });
  const { curve } = await D.fetchCurve('재시도');
  assert.ok(curve);
  assert.equal(calls, 3);
  assert.equal(waits[0], 1000); // Retry-After: 1초
  assert.equal(waits[1], 2000); // 두 번째 재시도 기본 대기

  let badCalls = 0;
  const bad = load({ setTimeout: fn => fn(), fetch: async () => { badCalls++; return { ok: false, status: 400 }; } });
  await assert.rejects(bad.fetchCurve('잘못된요청'), /HTTP 400/);
  assert.equal(badCalls, 1);
});

test('툴팁 로딩: 현재 가치 막대와 스피너를 먼저 표시하고 추정 후 1년 감가 구간 추가', async () => {
  const D = load();
  const curve = D.fitCurve(synthetic({ seed: 12 }));
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const content = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const loader = content.slice(content.indexOf('    let depreciationLoadStarted = false;'), content.indexOf('    let activityLoading = false;'));
  const elements = {};
  const context = vm.createContext({
    console: { log() {}, warn() {} }, Date, Math, setTimeout,
    tooltip: { querySelector: selector => (selector.startsWith('[') ? (elements[selector] ||= {}) : null) },
    fullData: { modelGroupName: '그랜저', yearlyMarketData: null },
    canShowDepreciation: true, carAgeYears: 5, price: 2000, year: 21, originPrice: 3800, nowMonth: 9,
    depreciationTotalText: '', clipboardExtras: {}, refreshClipboardText() {}, requestAnimationFrame() {}, positionTooltip() {},
    pending
  });
  vm.runInContext(`${source}\n${barSource}
    EncarDepreciation.fetchCurve = () => pending;
    ${loader}
    this.done = loadDepreciation();`, context);
  const forecast = elements['[data-encar-depreciation-forecast]'];
  assert.match(forecast.className, /encar-loading/);
  assert.equal(forecast.textContent, '감가곡선 계산 중…');
  const bar = elements['[data-encar-depreciation-bar]'];
  assert.match(bar.innerHTML, /data-depreciation-part="retained"/);
  assert.doesNotMatch(bar.innerHTML, /data-depreciation-part="forecast"/);
  release({ curve, reason: null });
  await context.done;
  assert.doesNotMatch(forecast.className, /encar-loading/);
  const loss = Math.round(D.estimate(curve, { age: 5, price: 2000, originPrice: 3800 }).yearLoss);
  assert.equal(forecast.textContent, `1년 예상 감가 ${loss.toLocaleString()}만원 · 1년 후 예상가 ${(2000 - loss).toLocaleString()}만원 ⓘ`);
  assert.match(bar.innerHTML, /data-depreciation-part="forecast"/);
});

function renderBar(originPrice, price, loss) {
  const context = vm.createContext({ originPrice, price, loss });
  vm.runInContext(`${barSource}\nthis.html = createDepreciationBar(originPrice, price, loss);`, context);
  const parts = Object.fromEntries([...context.html.matchAll(/data-depreciation-part="([^"]+)" style="width:([\d.e+-]+)%"/g)]
    .map(([, key, value]) => [key, Number(value)]));
  for (const percent of Object.values(parts)) assert.ok(percent >= 0 && percent <= 100);
  if (Object.keys(parts).length) assert.ok(Math.abs(Object.values(parts).reduce((a, b) => a + b, 0) - 100) < 1e-8);
  assert.doesNotMatch(context.html, /NaN|Infinity/);
  return { html: context.html, parts };
}

test('감가 막대: 감가 전 100% 초록, 현재 70%·1년 예상 10%p는 초록 60/주황 10/회색 30', () => {
  assert.deepEqual(renderBar(5000, 5000).parts, { retained: 100, past: 0 });
  assert.deepEqual(renderBar(5000, 3500).parts, { retained: 70, past: 30 });
  const predicted = renderBar(5000, 3500, 500);
  assert.deepEqual(predicted.parts, { retained: 60, forecast: 10, past: 30 });
  assert.match(predicted.html, /1년 후 잔존 60%/);
  assert.match(predicted.html, /1년 예상 감가 10%/);
  assert.match(predicted.html, /1년 후 예상가 3,000만원/);
});

test('감가 막대: 0 감가와 작은 감가도 실제 비율을 유지하고 현재 가치보다 더 차감하지 않음', () => {
  assert.deepEqual(renderBar(5000, 3500, 0).parts, { retained: 70, forecast: 0, past: 30 });
  assert.ok(renderBar(5000, 3500, 1).parts.forecast < 0.1);
  assert.deepEqual(renderBar(5000, 3500, 8000).parts, { retained: 0, forecast: 70, past: 30 });
  assert.deepEqual(renderBar(5000, 0, 0).parts, { retained: 0, forecast: 0, past: 100 });
});

test('감가 막대: 현재가가 신차가 초과 시 100% 범위만 표시하고 이를 알림', () => {
  const premium = renderBar(5000, 6000, 500);
  assert.deepEqual(premium.parts, { retained: 100, forecast: 0, past: 0 });
  assert.match(premium.html, /현재가가 신차가 초과/);
  assert.match(premium.html, /1년 예상 감가 500만원/);
  assert.deepEqual(renderBar(5000, 6000, 1500).parts, { retained: 90, forecast: 10, past: 0 });
});

test('감가 막대: 기준 가격이 없으면 비율을 만들지 않고 예측 실패를 0 감가로 표시하지 않음', () => {
  for (const origin of [0, -1, NaN, Infinity, null]) {
    assert.deepEqual(renderBar(origin, 3500, 500).parts, {});
  }
  for (const price of [-1, NaN, Infinity, null]) {
    assert.deepEqual(renderBar(5000, price, 500).parts, {});
  }
  for (const loss of [null, undefined, NaN, Infinity, -5]) {
    assert.deepEqual(renderBar(5000, 3500, loss).parts, { retained: 70, past: 30 });
  }
});
