/**
 * 엔카 품질 점수 - 팝업 로직
 */

document.addEventListener('DOMContentLoaded', () => {
  // DEFAULT_WEIGHTS는 constants.js에서 전역으로 로드됨 (popup.html 참조)

  const weightKeys = ['accident', 'mileage', 'price', 'inspection', 'rental', 'ownerChanges'];
  const weightControlIds = [
    ...weightKeys.map(key => `weight-${key}`),
    'btn-save-weights', 'btn-reset-weights', 'preset-condition', 'preset-price', 'preset-default'
  ];
  let weightsReady = false;
  let weightsSaving = false;

  // ---- 초기화 ----
  loadWeights();
  updateStatus();

  // ---- 가중치 슬라이더 ----
  weightKeys.forEach(key => {
    const slider = document.getElementById(`weight-${key}`);
    const valueEl = document.getElementById(`val-${key}`);

    slider.addEventListener('input', () => {
      valueEl.textContent = slider.value;
      updateTotal();
      showWeightsStatus('변경 중 · 조작을 마치면 자동 저장됩니다.');
    });
    // 드래그 종료/키보드 변경이 확정될 때 즉시 저장한다. 팝업 종료로 취소되는 지연 타이머는 쓰지 않는다.
    slider.addEventListener('change', saveWeights);
  });

  function updateTotal() {
    const total = weightKeys.reduce((sum, key) => {
      return sum + parseInt(document.getElementById(`weight-${key}`).value, 10);
    }, 0);

    document.getElementById('weight-total-value').textContent = total;
    const warning = document.getElementById('total-warning');
    warning.style.display = total !== 100 ? 'inline' : 'none';
  }

  function getWeightsFromUI() {
    const weights = {};
    weightKeys.forEach(key => {
      weights[key] = parseInt(document.getElementById(`weight-${key}`).value, 10);
    });
    return weights;
  }

  function setWeightsToUI(weights) {
    weightKeys.forEach(key => {
      const slider = document.getElementById(`weight-${key}`);
      const valueEl = document.getElementById(`val-${key}`);
      // 0도 유효한 가중치이므로 값이 없을 때만 기본값을 쓴다.
      slider.value = weights[key] ?? DEFAULT_WEIGHTS[key];
      valueEl.textContent = slider.value;
    });
    updateTotal();
  }

  function lockWeightControls(locked) {
    weightControlIds.forEach(id => { document.getElementById(id).disabled = locked; });
  }

  function showWeightsStatus(text, isError = false) {
    const status = document.getElementById('weights-save-status');
    status.textContent = text;
    status.className = isError ? 'weights-save-status is-error' : 'weights-save-status';
  }

  function loadWeights() {
    weightsReady = false;
    lockWeightControls(true);
    showWeightsStatus('저장한 배점 불러오는 중…');
    chrome.storage.local.get(['weights'], (result) => {
      if (chrome.runtime?.lastError) {
        showWeightsStatus(`불러오기 실패: ${chrome.runtime.lastError.message}`, true);
        const button = document.getElementById('btn-save-weights');
        button.textContent = '다시 불러오기';
        button.disabled = false;
        return;
      }
      setWeightsToUI(result.weights || DEFAULT_WEIGHTS);
      weightsReady = true;
      lockWeightControls(false);
      document.getElementById('btn-save-weights').textContent = '저장';
      showWeightsStatus('배점을 변경하면 자동 저장됩니다.');
    });
  }

  // ---- 가중치 저장: 실제 저장값을 재조회해 확인한 뒤에만 완료 표시 ----
  function saveWeights() {
    if (!weightsReady || weightsSaving) return;
    const weights = getWeightsFromUI();
    if (weightKeys.some(key => !Number.isFinite(weights[key]) || weights[key] < 0 || weights[key] > 50)) {
      showWeightsStatus('저장 실패: 항목별 배점은 0~50 사이의 숫자여야 합니다.', true);
      return;
    }
    weightsSaving = true;
    lockWeightControls(true);
    const button = document.getElementById('btn-save-weights');
    button.textContent = '저장 중…';
    showWeightsStatus('변경한 배점 저장 중…');
    const finish = error => {
      weightsSaving = false;
      lockWeightControls(false);
      button.textContent = error ? '다시 저장' : '✓ 저장됨';
      showWeightsStatus(error ? `저장 실패: ${error}` : '저장 확인 완료 · 팝업을 닫아도 배점이 유지됩니다.', Boolean(error));
    };
    try {
      chrome.storage.local.set({ weights }, () => {
        if (chrome.runtime?.lastError) {
          finish(chrome.runtime.lastError.message);
          return;
        }
        chrome.storage.local.get(['weights'], result => {
          if (chrome.runtime?.lastError) {
            finish(chrome.runtime.lastError.message);
            return;
          }
          const matches = weightKeys.every(key => result.weights?.[key] === weights[key]);
          finish(matches ? '' : '저장한 배점과 다시 읽은 값이 다릅니다. 다시 저장해주세요.');
        });
      });
    } catch (error) {
      finish(error.message);
    }
  }

  document.getElementById('btn-save-weights').addEventListener('click', () => {
    if (!weightsReady) loadWeights();
    else saveWeights();
  });

  // ---- 가중치 초기화 ----
  document.getElementById('btn-reset-weights').addEventListener('click', () => {
    setWeightsToUI(DEFAULT_WEIGHTS);
    saveWeights();
  });

  // ---- 전략 프리셋 ----
  const PRESETS = {
    condition: {  // 상태우선: 상태·이력 비중 ↑, 가격 비중 ↓
      accident: 30, mileage: 20, price: 5, inspection: 20, rental: 15, ownerChanges: 10
    },
    price: {      // 가격우선: 가격 비중 ↑, 상태·이력 비중 ↓
      accident: 10, mileage: 5, price: 40, inspection: 10, rental: 20, ownerChanges: 15
    }
  };

  document.getElementById('preset-condition').addEventListener('click', () => {
    applyPreset('condition', PRESETS.condition);
  });
  document.getElementById('preset-price').addEventListener('click', () => {
    applyPreset('price', PRESETS.price);
  });
  document.getElementById('preset-default').addEventListener('click', () => {
    applyPreset('default', DEFAULT_WEIGHTS);
  });

  function applyPreset(name, weights) {
    setWeightsToUI(weights);
    saveWeights();
    // 시각 피드백
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`preset-${name}`);
    btn.classList.add('active');
    setTimeout(() => btn.classList.remove('active'), 1200);
  }

  // ---- 재분석 ----
  document.getElementById('btn-rescan').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'RESCAN' }, (response) => {
          if (response?.success) {
            const btn = document.getElementById('btn-rescan');
            btn.innerHTML = '<span class="btn-icon">✓</span> 분석 시작됨';
            setTimeout(() => {
              btn.innerHTML = '<span class="btn-icon">🔄</span> 차량 재분석';
            }, 2000);
          }
        });
      }
    });
  });

  // ---- 최소 점수 필터 ----
  const minScoreSlider = document.getElementById('min-score-slider');
  const minScoreValue = document.getElementById('min-score-value');

  chrome.storage.local.get(['minScore'], (result) => {
    const minScore = result.minScore || 0;
    minScoreSlider.value = minScore;
    minScoreValue.textContent = `${minScore}점`;
  });

  minScoreSlider.addEventListener('input', () => {
    minScoreValue.textContent = `${minScoreSlider.value}점`;
  });

  document.getElementById('btn-apply-filter').addEventListener('click', () => {
    const minScore = parseInt(minScoreSlider.value, 10);
    chrome.storage.local.set({ minScore });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'APPLY_FILTER',
          minScore
        });
      }
    });

    const btn = document.getElementById('btn-apply-filter');
    btn.textContent = '✓ 적용됨';
    setTimeout(() => { btn.textContent = '필터 적용'; }, 1500);
  });

  // ---- OpenAI API 키 ----
  const apiKeyInput = document.getElementById('openai-api-key');
  chrome.storage.local.get(['openaiApiKey'], (result) => {
    if (result.openaiApiKey) apiKeyInput.value = result.openaiApiKey;
  });

  document.getElementById('btn-save-apikey').addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    chrome.storage.local.set({ openaiApiKey: key }, () => {
      const btn = document.getElementById('btn-save-apikey');
      btn.textContent = '✓ 저장됨';
      setTimeout(() => { btn.textContent = '저장'; }, 1500);
    });
  });

  // ---- 상태 업데이트 ----
  function updateStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS' }, (response) => {
          const dot = document.querySelector('.status-dot');
          const text = document.getElementById('status-text');

          if (chrome.runtime.lastError || !response) {
            dot.className = 'status-dot';
            text.textContent = '페이지 없음';
            return;
          }

          if (response.isProcessing) {
            dot.className = 'status-dot processing';
            text.textContent = '분석중...';
          } else if (response.processedCount > 0) {
            dot.className = 'status-dot active';
            text.textContent = `${response.processedCount}대 분석 완료`;
          } else {
            dot.className = 'status-dot';
            text.textContent = '대기중';
          }
        });
      }
    });
  }
});
