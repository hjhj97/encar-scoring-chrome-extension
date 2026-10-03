const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const start = source.indexOf('  function createNewListingMarker(');
const helper = source.slice(start, source.indexOf('\n  // ═', start));
const now = Date.parse('2026-10-03T12:00:00+09:00');
class FixedDate extends Date {
  static now() { return now; }
}
const context = vm.createContext({ Date: FixedDate });
vm.runInContext(helper, context);
const render = value => context.createNewListingMarker(value, now);

test('등록 직후부터 정확히 7일까지 표시, 경계 초과 및 미래 날짜는 제외', () => {
  assert.match(render('2026-10-03T12:00:00+09:00'), />N<\/span>/);
  assert.match(render('2026-09-26T12:00:00+09:00'), /encar-new-listing/);
  assert.equal(render('2026-09-26T11:59:59.999+09:00'), '');
  assert.equal(render('2026-10-03T12:00:00.001+09:00'), '');
  assert.equal(render('2026-08-01T12:00:00+09:00'), '');
});

test('시간대 없는 API 날짜는 한국 시간이며 Z/명시적 오프셋과 동일하게 판정', () => {
  const expected = render('2026-09-26T12:00:00+09:00');
  assert.equal(render('2026-09-26T12:00:00'), expected);
  assert.equal(render('2026-09-26T03:00:00Z'), expected);
  assert.equal(render('2026-09-25T23:00:00-04:00'), expected);
  assert.equal(render('2026-09-26T11:59:59'), '');
});

test('날짜 없음·형식 오류·존재하지 않는 날짜에는 표시하지 않음', () => {
  for (const value of [null, undefined, '', 0, {}, 'invalid', '2026-10-03',
    '2026-09-31T12:00:00', '2026-13-01T12:00:00', '2026-10-03T25:00:00',
    '2026-10-03T12:60:00', '2026-10-03T12:00:00+99:00']) {
    assert.equal(render(value), '', String(value));
  }
  assert.equal(context.createNewListingMarker('2026-10-03T12:00:00', NaN), '');
});

test('점수 박스 생성 경로에서 신규 매물만 N 표시 (목록/상세 공통)', () => {
  const badgeStart = source.indexOf('  function createScoreBadge(');
  const prefix = source.slice(badgeStart, source.indexOf('    // ── 툴팁 상세 정보 계산', badgeStart));
  context.document = { createElement() { return {style: {}, innerHTML: ''}; } };
  context.EncarScoring = { DEFAULT_WEIGHTS: {}, getGradeGradient: () => 'green' };
  vm.runInContext(`${prefix}\nreturn badge;\n}`, context);
  const score = {grade: 'A', total: 89};
  for (const cardData of [{carId: '123'}, {modelName: '상세 페이지'}]) {
    const badge = context.createScoreBadge(score, cardData, {}, {
      carId: '123', firstAdvertisedDateTime: '2026-10-01T12:00:00'
    });
    assert.match(badge.innerHTML, /89점/);
    assert.match(badge.innerHTML, /aria-label="등록 후 7일 이내 매물"/);
    assert.equal((badge.innerHTML.match(/encar-new-listing/g) || []).length, 1);
  }
  assert.doesNotMatch(context.createScoreBadge(score, {}, {}, {}).innerHTML, /encar-new-listing/);
  assert.doesNotMatch(context.createScoreBadge(score, {}, {}, {
    firstAdvertisedDateTime: '2026-09-01T12:00:00'
  }).innerHTML, /encar-new-listing/);
});
