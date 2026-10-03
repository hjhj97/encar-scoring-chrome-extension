const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const files = ['constants.js', 'scoring/inspection.js'];

function load() {
  const context = vm.createContext({ window: {}, Math });
  const source = files.map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
  vm.runInContext(`${source}\nthis.ns = window.EncarScoring;`, context);
  return context.ns;
}

const counts = (overrides = {}) => ({
  ONE: { X: 0, W: 0, C: 0 }, TWO: { X: 0, W: 0, C: 0 }, A: { X: 0, W: 0, C: 0 }, B: { X: 0, W: 0, C: 0 }, ...overrides
});

// 매물 42236144(BMW 640d)의 실제 성능점검표: 외판 교환 4 · 외판 1랭크 판금 3 · 쿼터 패널 판금 1, 엔카진단(외판 교환 판정)
const bmw = {
  hasInspection: true, hasReplacement: true, hasWelding: true,
  rankCounts: counts({ ONE: { X: 4, W: 3, C: 0 }, TWO: { X: 0, W: 1, C: 0 } }),
  hasDiagnosis: true, diagnosisTier: 'BASIC', diagPanelReplacement: true
};

test('엔카진단 매물도 성능점검표의 교환·판금 감점을 먼저 적용한다', () => {
  const ns = load();
  // 15 - (교환 4×1 + 판금 3×2 + 쿼터 판금 1×3) = 2. 진단 외판 교환(-3)은 성능점검표에 이미 반영돼 다시 감점하지 않음
  assert.equal(ns.scoreInspection(bmw, 15), 2);
  // 같은 차가 진단이 없으면 미진단 감점(-5)까지 받는다
  assert.equal(ns.scoreInspection({ ...bmw, hasDiagnosis: false }, 15), 0);
});

test('엔카진단 교환 판정은 성능점검표에 같은 종류의 교환이 없을 때만 감점', () => {
  const ns = load();
  const clean = { hasInspection: true, rankCounts: counts(), hasDiagnosis: true, diagnosisTier: 'BASIC' };
  assert.equal(ns.scoreInspection({ ...clean, diagPanelReplacement: true }, 15), 12);
  assert.equal(ns.scoreInspection({ ...clean, diagFrameReplacement: true }, 15), 3);
  // 성능점검표에 골격 교환이 이미 있으면 진단 프레임 교환을 다시 감점하지 않음 (이중 감점 방지)
  const frameOnSheet = { ...clean, diagFrameReplacement: true, rankCounts: counts({ B: { X: 0, W: 0, C: 0 }, A: { X: 1, W: 0, C: 0 } }) };
  assert.equal(ns.scoreInspection(frameOnSheet, 15), 5);
  // 성능점검표가 없으면 진단 판정으로만 감점
  assert.equal(ns.scoreInspection({ hasDiagnosis: true, diagnosisTier: 'BASIC', diagPanelReplacement: true }, 15), 12);
});

test('엔카진단++ 가산점은 사고·수리 감점이 없는 차량에만 준다', () => {
  const ns = load();
  const plusPlus = { hasInspection: true, rankCounts: counts(), hasDiagnosis: true, diagnosisTier: 'PLUSPLUS' };
  assert.equal(ns.scoreInspection(plusPlus, 15), 19);
  // 외판 판금 1건(-2)이 있으면 가산점 없이 13점 (예전에는 +4로 상쇄돼 17점)
  assert.equal(ns.scoreInspection({ ...plusPlus, rankCounts: counts({ ONE: { X: 0, W: 1, C: 0 } }) }, 15), 13);
  assert.equal(ns.scoreInspection({ ...plusPlus, diagPanelReplacement: true }, 15), 12);
});

test('진단이 없는 매물의 점수는 기존과 같다', () => {
  const ns = load();
  assert.equal(ns.scoreInspection({ hasInspection: true, rankCounts: counts() }, 15), 10);
  assert.equal(ns.scoreInspection({ hasInspection: true, rankCounts: counts({ B: { X: 1, W: 0, C: 0 } }) }, 15), 0);
  assert.equal(ns.scoreInspection({ hasInspection: true, rankCounts: null, hasWelding: true }, 15), 0);
  assert.equal(ns.scoreInspection({ hasInspection: false }, 15), 2.5);
  assert.equal(ns.scoreInspection({ isInspectionPrivate: true, hasDiagnosis: true }, 15), 0);
});
