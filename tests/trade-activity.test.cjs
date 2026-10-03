const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../background.js'), 'utf8');

function setup({ sold = 12, total = sold, wrongFilter = false, fail = false, distinctPages = false, failFirst = 0, failStatus = 503, restrictedYears = false, soldDates = null } = {}) {
  let calls = 0;
  const listeners = [];
  const requestedUrls = [];
  const category = { manufacturerCd: '001', modelCd: '002', gradeCd: '003',
    gradeDetailCd: '004', modelGroupCd: '005', modelGroupName: '테스트', modelName: '테스트 (G01)',
    gradeName: '3.0', gradeDetailName: '프리미엄', yearMonth: '202201' };
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()).replaceAll('-', '/');
  const inputs = { carid: '123', mnfccd: '001', mdlgroupcd: '005', headfiltercd: '006', mdlcd: wrongFilter ? '999' : '002',
    clsheadcd: '003', clsdetailcd: '004', styear: '202201', endyear: '202212' };
  const html = Object.entries(inputs).map(([k, v]) => `<input id="${k}" value="${v}">`).join('') +
    `<div class="part result"><strong>${total}</strong></div><tbody>` +
    Array.from({ length: sold }, (_, i) => `<tr><td>${i}</td><td class="fdt end">${soldDates?.[i] || date}</td></tr>`).join('') + '</tbody>';
  const row = { Id: 1, Model: category.modelName, Badge: '3.0', BadgeDetail: '프리미엄', Year: 202201 };
  const noop = { addListener() {} };
  // 재시도 대기(1·2·4초)는 테스트에서 즉시 진행한다.
  const context = vm.createContext({ URL, Date, TextDecoder, AbortSignal, console, setTimeout: fn => fn(),
    importScripts() {}, chrome: { runtime: { onMessage: {addListener(fn) {listeners.push(fn);}},
      onInstalled: noop, onConnect: noop }, tabs: {onUpdated: noop} },
    fetch: async url => {
      calls++;
      requestedUrls.push(new URL(url));
      if (fail) return {ok: false, status: failStatus};
      if (calls <= failFirst) return {ok: false, status: 429, headers: {get: () => null}};
      if (String(url).includes('/vehicle/')) return {ok: true, json: async () => ({vehicleId: 123, category})};
      if (String(url).includes('soldoutCars')) {
        const params = new URL(url).searchParams;
        let page = html;
        if (!params.has('carid')) {
          assert.equal(params.get('styear'), '');
          assert.equal(params.get('endyear'), '');
          assert.equal(params.get('clsheadcd'), '003');
          assert.equal(params.get('clsdetailcd'), '004');
          page = page.replace('id="carid" value="123"', 'id="carid" value=""');
          if (!restrictedYears) page = page.replace('value="202201"', 'value=""').replace('value="202212"', 'value=""');
        }
        if (distinctPages) page = page.replace('<tbody>', `<tbody><!--${params.get('pagenum')}-->`);
        return {ok: true, arrayBuffer: async () => Buffer.from(page)};
      }
      return {ok: true, json: async () => ({Count: 6, SearchResults: [row, row,
        {...row, Id: 2, ServiceCopyCar: 'DUPLICATION'}, {...row, Id: 3, Badge: '3.0d'},
        {...row, Id: 4, Year: 202101}, {...row, Id: 5}]})};
    }
  });
  vm.runInContext(source, context);
  return {run: () => context.fetchTradeActivity('123'), calls: () => calls, listeners, category, requestedUrls};
}

test('연식에 관계없이 동일 모델·트림 집계, 중복 제외 및 연식 간 캐시 공유', async () => {
  const env = setup();
  const result = await env.run();
  assert.equal(result.sold, 12);
  assert.equal(result.active, 3); // 2021년 차량도 포함
  assert.equal(result.soldComplete, true);
  assert.equal(result.activeComplete, true);
  assert.match(result.scope, /전체 연식/);
  const search = env.requestedUrls.find(url => url.pathname.includes('/search/'));
  assert.doesNotMatch(search.searchParams.get('q'), /Year\./);
  env.category.yearMonth = '202101';
  await env.run();
  assert.equal(env.calls(), 5); // 상세 + 조건 조회 + 전체 연식 조회 + 검색, 캐시 재사용 시 상세 1회만 추가
});
test('실제 판매완료 0건은 실패와 구별', async () => {
  const r = await setup({sold: 0}).run();
  assert.equal(r.sold, 0);
  assert.equal(r.soldComplete, true);
});
test('조건이 달라진 판매완료 응답은 거부', async () => {
  await assert.rejects(setup({wrongFilter: true}).run(), /조건/);
});
test('같은 페이지를 반복 반환하면 집계 거부', async () => {
  await assert.rejects(setup({sold: 20, total: 1000}).run(), /반복/);
});
test('네트워크 실패는 0건으로 변환하지 않음', async () => {
  const env = setup({fail: true});
  await assert.rejects(env.run(), /503/);
  assert.equal(env.calls(), 4); // 최초 1회 + 재시도 3회
});
test('목록 페이지 메시지는 네트워크 요청 없이 거부', () => {
  const env = setup();
  let response;
  const keepAlive = env.listeners[0]({type: 'FETCH_ENCAR_TRADE_ACTIVITY', carId: '123'},
    {url: 'https://car.encar.com/list/car'}, r => {response = r;});
  assert.equal(keepAlive, false);
  assert.equal(response.ok, false);
  assert.equal(env.calls(), 0);
});

test('20페이지에서 30일 경계를 못 찾으면 부분 집계', async () => {
  const r = await setup({sold: 20, total: 1000, distinctPages: true}).run();
  assert.equal(r.sold, 400);
  assert.equal(r.soldComplete, false);
});

test('서버가 특정 연식으로 제한된 결과를 반환하면 거부', async () => {
  await assert.rejects(setup({restrictedYears: true}).run(), /조건/);
});

test('판매일은 오늘 포함 최근 30일만 집계 (등록연도와 별개)', async () => {
  const now = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Seoul'}).format(new Date());
  const dateAt = offset => {
    const d = new Date(`${now}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10).replaceAll('-', '/');
  };
  const result = await setup({sold: 4, soldDates: [dateAt(0), dateAt(-29), dateAt(-30), dateAt(-60)]}).run();
  assert.equal(result.start, dateAt(-29));
  assert.equal(result.end, dateAt(0));
  assert.equal(result.sold, 2);
  assert.equal(result.soldComplete, true);
});

async function renderActivity(data, ok = true) {
  const content = fs.readFileSync(require('node:path').join(__dirname, '../content.js'), 'utf8');
  // 복사 텍스트 조립 도우미(clipboardExtras/refreshClipboardText)도 실제 소스에서 함께 가져온다.
  const clipboardHelper = content.slice(content.indexOf('    const clipboardExtras = {};'), content.indexOf('    if (canShowDepreciation'));
  const loader = clipboardHelper + content.slice(content.indexOf('    let activityLoading = false;'), content.indexOf('    // 툴팁이 잘리는 현상'));
  const elements = {};
  const ctx = vm.createContext({Date, console: {warn() {}}, canAnalyzeSoldOut: true, soldOutLookupId: '123',
    clipboardLines: ['차량 정보'], clipboardText: '', positionTooltip() {}, requestAnimationFrame() {},
    tooltip: {querySelector(selector) {return elements[selector] ||= {}; }},
    chrome: {runtime: {sendMessage(_message, callback) {callback({ok, data});}}}
  });
  await vm.runInContext(loader + '\nloadTradeActivity();', ctx);
  return {
    text: Object.values(elements).map(e => e.innerHTML ? e.innerHTML.replace(/<[^>]*>/g, '') : e.textContent).join('\n'),
    html: Object.values(elements).map(e => e.innerHTML || '').join(''),
    clipboard: ctx.clipboardText
  };
}

test('표시: 최근 30일 실제 건수·전체 연식 합계와 비율, 복사 텍스트', async () => {
  const base = {sold: 27, active: 17, soldComplete: true, activeComplete: true,
    scope: '동일 트림 · 전체 연식', start: '2026/09/04', end: '2026/10/03'};
  const normal = await renderActivity(base);
  assert.match(normal.text, /현재 판매 중 17대 · 38.6%/);
  assert.match(normal.text, /최근 30일 판매완료 27건 · 61.4%/);
  assert.match(normal.text, /매물 합계 44건/);
  assert.match(normal.html, /fill="#42A5F5"/);
  assert.match(normal.html, /fill="#EF5350"/);
  assert.match(normal.clipboard, /매물 합계 44건/);
  assert.match(normal.clipboard, /신규 등록 대수가 아닙니다/);
  assert.match(normal.clipboard, /전체 연식/);
  assert.doesNotMatch(normal.html + normal.clipboard, /평균 등록|평균 판매완료|최근 90일/);
  assert.doesNotMatch(normal.html + normal.clipboard, /재고 소진|예상 판매 기간/);
  const partial = await renderActivity({...base, soldComplete: false});
  assert.match(partial.text, /이상/);
  assert.doesNotMatch(partial.html, /<svg/);
  assert.match(partial.text, /매물 합계 44건 이상 · 집계 일부/);
  assert.match((await renderActivity({...base, sold: 0})).text, /매물 합계 17건/);
  assert.match((await renderActivity({...base, active: 0})).text, /매물 합계 27건/);
  assert.match((await renderActivity(null, false)).text, /조회 실패/);
});

test('현재 50대 + 최근 30일 판매완료 20건 = 합계 70건, 0건·부분 집계', async () => {
  const base = {sold: 20, active: 50, soldComplete: true, activeComplete: true, scope: '테스트', start: '', end: ''};
  assert.match((await renderActivity(base)).text, /매물 합계 70건/);
  const small = await renderActivity({...base, sold: 3});
  assert.match(small.text, /판매완료 3건/);
  assert.match(small.text, /매물 합계 53건/);
  const oneSale = await renderActivity({...base, sold: 1, active: 1000});
  assert.match(oneSale.text, /매물 합계 1,001건/);
  const partialInventory = await renderActivity({...base, sold: 90, activeComplete: false});
  assert.match(partialInventory.text, /매물 합계 140건 이상 · 집계 일부/);
  assert.doesNotMatch(partialInventory.html, /<svg/);
  const empty = await renderActivity({...base, sold: 0, active: 0});
  assert.match(empty.text, /비교할 매물 없음/);
  assert.match(empty.text, /매물 합계 0건/);
});

test('429는 잠시 뒤 재시도해 정상 집계, 404는 재시도하지 않음', async () => {
  const env = setup({ failFirst: 2 });
  const result = await env.run();
  assert.equal(result.sold, 12);
  assert.equal(env.calls(), 6); // 429 두 번 + 정상 요청 4회(차량·조건·전체 연식 판매완료·현재 매물)

  const notFound = setup({ fail: true, failStatus: 404 });
  await assert.rejects(notFound.run(), /404/);
  assert.equal(notFound.calls(), 1);
});
