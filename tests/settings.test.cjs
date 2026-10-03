const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const defaultsSource = fs.readFileSync(path.join(root, 'constants.js'), 'utf8');
const customWeights = { accident: 25, mileage: 15, price: 25, inspection: 20, rental: 0, ownerChanges: 15 };

function storage(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data, writes,
    get(keys, callback) { callback(Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]))); },
    set(values, callback) { writes.push(values); Object.assign(data, values); callback?.(); }
  };
}

function loadBackground(initial) {
  const local = storage(initial);
  let installed;
  const noop = {addListener() {}};
  const context = vm.createContext({console: {log() {}}, importScripts() {}, chrome: {
    storage: {local}, runtime: {onInstalled: {addListener(fn) {installed = fn;}}, onMessage: noop, onConnect: noop},
    tabs: {onUpdated: noop}
  }});
  vm.runInContext(defaultsSource + '\n' + fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return {local, installed};
}

test('확장 업데이트/재로드 시 사용자 배점과 필터를 덮어쓰지 않는다', () => {
  const {local, installed} = loadBackground({weights: customWeights, minScore: 75});
  installed({reason: 'update'});
  assert.deepEqual(local.data.weights, customWeights);
  assert.equal(local.data.minScore, 75);
  assert.equal(local.writes.length, 0);
});

test('최초 설치는 기본값을 넣고 누락된 설정만 보충한다', () => {
  const fresh = loadBackground({});
  fresh.installed({reason: 'install'});
  assert.equal(fresh.local.data.weights.price, 25);
  assert.equal(fresh.local.data.minScore, 0);
  const partial = loadBackground({weights: customWeights});
  partial.installed({reason: 'update'});
  assert.deepEqual(partial.local.data.weights, customWeights);
  assert.equal(partial.local.data.minScore, 0);
});

function loadPopup(local, runtime = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', style: {}, handlers: {}, classList: {add() {}, remove() {}},
      addEventListener(event, fn) {this.handlers[event] = fn;}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {addEventListener(_event, fn) {fn();}, getElementById: element, querySelectorAll: () => []},
    setTimeout() {}, chrome: {runtime, storage: {local}, tabs: {query(_query, callback) {callback([]);}}}
  });
  vm.runInContext(defaultsSource + '\n' + fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), context);
  return {element};
}

test('팝업은 0점 배점을 유지하고 저장/프리셋/초기화 값을 저장소에 전달한다', () => {
  const local = storage({weights: customWeights});
  const {element} = loadPopup(local);
  assert.equal(Number(element('weight-rental').value), 0);
  element('weight-price').value = '40';
  element('weight-price').handlers.input();
  element('btn-save-weights').handlers.click();
  assert.equal(local.data.weights.price, 40);
  assert.equal(local.data.weights.rental, 0);
  const reopened = loadPopup(local);
  assert.equal(Number(reopened.element('weight-price').value), 40);
  assert.equal(Number(reopened.element('weight-rental').value), 0);
  element('preset-condition').handlers.click();
  assert.equal(local.data.weights.price, 5);
  element('btn-reset-weights').handlers.click();
  assert.equal(local.data.weights.price, 25);
});

test('슬라이더 변경만으로 자동 저장되고 팝업을 다시 열어도 값이 유지된다', () => {
  const local = storage({weights: customWeights});
  const first = loadPopup(local);
  first.element('weight-price').value = '40';
  first.element('weight-price').handlers.input();
  first.element('weight-price').handlers.change?.();
  const reopened = loadPopup(local);
  assert.equal(Number(reopened.element('weight-price').value), 40);
  assert.equal(Number(reopened.element('weight-rental').value), 0);
  assert.match(first.element('weights-save-status').textContent, /저장 확인 완료/);
});

test('저장 실패를 성공으로 표시하지 않고 오류를 보여준다', () => {
  const runtime = {};
  const local = storage({weights: customWeights});
  local.set = (_values, callback) => {
    runtime.lastError = {message: '저장소 오류'};
    callback();
    delete runtime.lastError;
  };
  const {element} = loadPopup(local, runtime);
  element('weight-price').value = '40';
  element('btn-save-weights').handlers.click();
  assert.match(element('weights-save-status').textContent, /저장 실패.*저장소 오류/);
  assert.equal(local.data.weights.price, 25);
  assert.equal(element('btn-save-weights').disabled, false);
});

test('쓰기 성공 콜백 후에도 실제 저장값이 다르면 완료로 표시하지 않는다', () => {
  const local = storage({weights: customWeights});
  local.set = (_values, callback) => callback(); // 성공 응답만 있고 값은 저장되지 않은 상황
  const {element} = loadPopup(local);
  element('weight-price').value = '40';
  element('btn-save-weights').handlers.click();
  assert.match(element('weights-save-status').textContent, /저장 실패/);
});

test('초기 저장값을 읽기 전에는 슬라이더·프리셋을 잠그고, 읽기 실패 시 재시도한다', () => {
  const local = storage({weights: customWeights});
  const realGet = local.get;
  const runtime = {};
  let finishRead;
  local.get = (keys, callback) => {
    if (keys.includes('weights')) finishRead = callback;
    else realGet(keys, callback);
  };
  const {element} = loadPopup(local, runtime);
  assert.equal(element('weight-price').disabled, true);
  assert.equal(element('preset-price').disabled, true);
  runtime.lastError = {message: '읽기 오류'};
  finishRead({});
  delete runtime.lastError;
  assert.match(element('weights-save-status').textContent, /불러오기 실패/);
  assert.equal(element('weight-price').disabled, true);
  assert.equal(element('btn-save-weights').disabled, false);
  element('btn-save-weights').handlers.click();
  finishRead({weights: customWeights});
  assert.equal(Number(element('weight-price').value), 25);
  assert.equal(element('weight-price').disabled, false);
});

test('비동기 쓰기와 재조회가 모두 끝나기 전에는 저장 완료를 표시하지 않는다', () => {
  const local = storage({weights: customWeights});
  const {element} = loadPopup(local);
  let finishWrite;
  let finishVerify;
  local.set = (values, callback) => {
    finishWrite = () => {Object.assign(local.data, values); callback();};
  };
  local.get = (_keys, callback) => {finishVerify = callback;};
  element('weight-price').value = '40';
  element('weight-price').handlers.change();
  assert.equal(element('weight-price').disabled, true);
  assert.match(element('weights-save-status').textContent, /저장 중/);
  finishWrite();
  assert.doesNotMatch(element('weights-save-status').textContent, /확인 완료/);
  finishVerify({weights: local.data.weights});
  assert.equal(element('weight-price').disabled, false);
  assert.match(element('weights-save-status').textContent, /확인 완료/);
});
