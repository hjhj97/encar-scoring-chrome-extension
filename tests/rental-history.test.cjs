const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const scoringFiles = ['constants.js', 'scoring/grade.js', 'scoring/accident.js', 'scoring/mileage.js',
  'scoring/price.js', 'scoring/inspection.js', 'scoring/rental.js', 'scoring/owner.js', 'scoring/calculator.js'];

/** 실제 파서 → 종합점수 경로를 저장된 용도 이력으로 실행한다. 네트워크 요청은 하지 않는다. */
async function parseUsage(carInfoUse1s, { carId = '1', maxPoints = 20, recordView = true } = {}) {
  const record = { openData: true, carInfoUse1s, carInfoUse2s: carInfoUse1s?.map(() => '1') };
  const before = JSON.stringify(record);
  const scope = vm.createContext({
    window: {}, console: { log() {}, warn() {} },
    fetch: async url => {
      const body = url.includes('/record/') ? record : url.includes('/readside/vehicle/') ? {
        vehicleId: carId, vehicleNo: 'TEST', category: { yearMonth: '202001' },
        condition: { accident: { recordView }, inspection: { formats: ['TABLE'] } }
      } : url.includes('/options/') ? [] : {};
      return { ok: true, json: async () => body };
    }
  });
  vm.runInContext(`${scoringFiles.map(read).join('\n')}\n${read('detail-parser.js')}
    this.parser = DetailParser; this.scoring = window.EncarScoring; this.weights = DEFAULT_WEIGHTS;`, scope);
  const data = await scope.parser.fetchDetailData(carId);
  const score = scope.scoring.calculateScore(data, { ...scope.weights, rental: maxPoints });
  assert.equal(JSON.stringify(record), before, '원본 API 이력은 변경하지 않는다');
  return { data, score };
}

for (const [carId, history] of [
  ['42139896', ['2', '2']],
  ['42757776', ['2', '2', '2']]
]) {
  test(`매물 ${carId}: 실제 확인한 중복 용도 코드는 용도변경이 아니며 20/20점`, async () => {
    const { data, score } = await parseUsage(history, { carId });
    assert.equal(data.hasRentalHistory, false);
    assert.equal(data.hasUsageChange, false);
    assert.equal(score.breakdown.rental, 20);
  });
}

test('한 종류의 코드만 있으면 반복 횟수와 관계없이 만점', async () => {
  for (const history of [['2'], ['1', '1'], Array(10).fill('2')]) {
    const { data, score } = await parseUsage(history);
    assert.equal(data.hasUsageChange, false);
    assert.equal(score.breakdown.rental, 20);
  }
});

test('서로 다른 코드가 있으면 중복 포함 여부와 관계없이 기존 용도변경 감점 유지', async () => {
  for (const history of [['1', '2'], ['2', '1', '2'], ['1', '1', '2', '2']]) {
    const { data, score } = await parseUsage(history);
    assert.equal(data.hasRentalHistory, false);
    assert.equal(data.hasUsageChange, true);
    assert.equal(score.breakdown.rental, 6);
  }
});

test('기존 렌트 판정 코드 3·4가 있으면 중복 여부와 무관하게 0점 유지', async () => {
  for (const history of [['3'], ['3', '3'], ['4', '4'], ['2', '3', '3'], ['3', '4']]) {
    const { data, score } = await parseUsage(history);
    assert.equal(data.hasRentalHistory, true);
    assert.equal(score.breakdown.rental, 0);
  }
});

test('사용자가 바꾼 배점과 0점 배점도 정상 반영', async () => {
  for (const maxPoints of [0, 30]) {
    assert.equal((await parseUsage(['2', '2'], { maxPoints })).score.breakdown.rental, maxPoints);
    assert.equal((await parseUsage(['1', '2'], { maxPoints })).score.breakdown.rental, maxPoints * 0.3);
    assert.equal((await parseUsage(['3', '3'], { maxPoints })).score.breakdown.rental, 0);
  }
});

test('빈 이력의 기존 처리와 보험이력 비공개 페널티는 유지', async () => {
  for (const history of [undefined, null, []]) {
    const { data, score } = await parseUsage(history);
    assert.equal(data.hasUsageChange, false);
    assert.equal(score.breakdown.rental, 20);
  }
  const privateRecord = await parseUsage(['2', '2'], { recordView: false });
  assert.equal(privateRecord.data.isInsurancePrivate, true);
  assert.ok(privateRecord.score.penalties.some(item => item.key === 'private'));
});
