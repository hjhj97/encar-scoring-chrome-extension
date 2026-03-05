/**
 * 엔카 품질 점수 - 팝업 로직
 */

document.addEventListener('DOMContentLoaded', () => {
  // DEFAULT_WEIGHTS는 constants.js에서 전역으로 로드됨 (popup.html 참조)

  const weightKeys = ['accident', 'mileage', 'price', 'inspection', 'rental', 'ownerChanges'];

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
    });
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
      slider.value = weights[key] || DEFAULT_WEIGHTS[key];
      valueEl.textContent = slider.value;
    });
    updateTotal();
  }

  function loadWeights() {
    chrome.storage.local.get(['weights'], (result) => {
      setWeightsToUI(result.weights || DEFAULT_WEIGHTS);
    });
  }

  // ---- 가중치 저장 ----
  document.getElementById('btn-save-weights').addEventListener('click', () => {
    const weights = getWeightsFromUI();
    chrome.storage.local.set({ weights }, () => {
      const btn = document.getElementById('btn-save-weights');
      btn.textContent = '✓ 저장됨';
      btn.style.background = 'rgba(76, 175, 80, 0.2)';
      btn.style.borderColor = 'rgba(76, 175, 80, 0.3)';
      setTimeout(() => {
        btn.textContent = '저장';
        btn.style.background = '';
        btn.style.borderColor = '';
      }, 1500);
    });
  });

  // ---- 가중치 초기화 ----
  document.getElementById('btn-reset-weights').addEventListener('click', () => {
    setWeightsToUI(DEFAULT_WEIGHTS);
    chrome.storage.local.set({ weights: DEFAULT_WEIGHTS });
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
    chrome.storage.local.set({ weights });
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
