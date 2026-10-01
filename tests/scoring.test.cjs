const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const files = ['constants.js', 'scoring/grade.js', 'scoring/accident.js', 'scoring/mileage.js', 'scoring/price.js',
  'scoring/inspection.js', 'scoring/rental.js', 'scoring/owner.js', 'scoring/calculator.js'];

function load() {
  const context = vm.createContext({ window: {}, Date, Math, console });
  const source = files.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  vm.runInContext(`${source}\nthis.ns = window.EncarScoring; this.W = DEFAULT_WEIGHTS;`, context);
  return { ns: context.ns, W: context.W };
}

const rank = () => ({ ONE: { X: 0, W: 0, C: 0 }, TWO: { X: 0, W: 0, C: 0 }, A: { X: 0, W: 0, C: 0 }, B: { X: 0, W: 0, C: 0 } });
const clean = {
  year: 21, month: 3, mileage: 60000, price: 2000, originPrice: 4000,
  accidentAmounts: [], insuranceHistory: [], ownerChangeCount: 0, ownerChanges: [],
  hasInspection: true, rankCounts: rank(), hasDiagnosis: true, diagnosisTier: 'PLUSPLUS',
  diagReplacedParts: [], soldOutCarType: 'kor'
};

test('성능점검 점수가 배점을 넘지 않는다', () => {
  const { ns, W } = load();
  assert.equal(ns.scoreInspection(clean, W.inspection), W.inspection);
  assert.equal(ns.scoreInspection(clean, 30), 30);
});

test('고정 감점이 가중치에 비례한다', () => {
  const { ns, W } = load();
  const frame = { ...clean, hasDiagnosis: false, rankCounts: { ...rank(), B: { X: 1, W: 0, C: 0 } } };
  const atDefault = W.inspection - ns.scoreInspection(frame, W.inspection);
  const atDouble = 2 * W.inspection - ns.scoreInspection(frame, 2 * W.inspection);
  assert.equal(atDouble, atDefault * 2);
  const old = { ...clean, mileage: 260000 };
  assert.equal(ns.scoreMileage(old, 20), 2 * ns.scoreMileage(old, 10));
});

test('엔카진단 차량도 골격 판금을 감점한다', () => {
  const { ns, W } = load();
  const welded = { ...clean, diagnosisTier: 'BASIC', rankCounts: { ...rank(), B: { X: 0, W: 1, C: 0 } } };
  assert.equal(ns.scoreInspection(welded, W.inspection), W.inspection - 12);
});
