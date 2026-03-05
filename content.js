/**
 * 엔카 중고차 품질 점수 - Content Script
 * 리스트 페이지에서 차량 데이터를 추출하고 점수 배지를 삽입
 */

(async function () {
  'use strict';

  console.log('[EncarScore] 크롬 익스텐션 로드됨');

  // 처리 상태 추적
  const processedCards = new Set();
  let isProcessing = false;

  /**
   * 차량 카드에서 기본 데이터 추출
   */
  function extractCardData(cardEl) {
    const data = {
      element: cardEl,
      carId: null,
      modelName: '',
      year: 0,
      mileage: 0,
      fuelType: '',
      region: '',
      price: 0,
      color: ''
    };

    try {
      // carId 추출 (링크에서)
      const href = cardEl.getAttribute('href') || '';
      const idMatch = href.match(/detail\/(\d+)/);
      if (idMatch) {
        data.carId = idMatch[1];
      }

      // 모델명 추출
      const modelEl = cardEl.querySelector('strong');
      if (modelEl) {
        data.modelName = modelEl.textContent.trim();
      }

      // 스펙 추출 (ul > li 구조)
      const specItems = cardEl.querySelectorAll('ul li');
      if (specItems.length >= 1) {
        // 연식: "20/01식" → year: 20, month: 1
        const yearText = specItems[0]?.textContent?.trim() || '';
        const yearMatch = yearText.match(/(\d{2})\/(\d{2})식/);
        if (yearMatch) {
          data.year  = parseInt(yearMatch[1], 10);
          data.month = parseInt(yearMatch[2], 10);
        }
      }
      if (specItems.length >= 2) {
        // 주행거리: "77,173km" → 77173
        const kmText = specItems[1]?.textContent?.trim() || '';
        const kmMatch = kmText.match(/([\d,]+)\s*km/i);
        if (kmMatch) data.mileage = parseInt(kmMatch[1].replace(/,/g, ''), 10);
      }
      if (specItems.length >= 3) {
        data.fuelType = specItems[2]?.textContent?.trim() || '';
      }
      if (specItems.length >= 4) {
        data.region = specItems[3]?.textContent?.trim() || '';
      }

      // 가격 추출: "2,390만원" → 2390
      const allSpans = cardEl.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent.trim();
        const priceMatch = text.match(/([\d,]+)\s*만\s*원/);
        if (priceMatch) {
          data.price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
          break;
        }
      }

      // 색상 추출: "검정색 계열"
      for (const span of allSpans) {
        const text = span.textContent.trim();
        if (text.includes('계열') || text.includes('색')) {
          if (!text.includes('만원') && text.length < 20) {
            data.color = text;
          }
        }
      }
    } catch (error) {
      console.warn('[EncarScore] 카드 데이터 추출 오류:', error);
    }

    return data;
  }

  /**
   * 점수 배지 DOM 생성
   */
  function createScoreBadge(scoreResult, cardData, weights, fullData = {}) {
    const w = weights || EncarScoring.DEFAULT_WEIGHTS;
    const badge = document.createElement('div');
    badge.className = 'encar-score-badge';
    badge.style.background = EncarScoring.getGradeGradient(scoreResult.grade);

    badge.innerHTML = `
      <div class="encar-score-grade">${scoreResult.grade}</div>
      <div class="encar-score-number">${scoreResult.total}점</div>
    `;

    // ── 툴팁 상세 정보 계산 ──
    const { originPrice = 0, price = 0, mileage = 0, year = 0,
            insuranceCount = 0, isInsurancePrivate = false,
            hasUnavailablePeriod = false, unavailablePeriods = [],
            isInspectionPrivate = false } = fullData;

    // 사고/보험이력 건수 텍스트
    const accidentLines = [];
    if (isInsurancePrivate) {
      accidentLines.push('조회불가 · 비공개');
    } else {
      accidentLines.push(insuranceCount === 0 ? '무사고' : `보험처리 ${insuranceCount}건`);
    }
    if (hasUnavailablePeriod) {
      accidentLines.push(`⚠️ 정보제공 불가기간: ${unavailablePeriods.join(', ')}`);
    }
    const accidentText = accidentLines.join('\n');

    // 신차가 & 현재가 비율
    const priceDetail = (originPrice > 0 && price > 0)
      ? `신차가 ${originPrice.toLocaleString()}만원 · 현재 ${Math.round(price / originPrice * 100)}%`
      : originPrice > 0
        ? `신차가 ${originPrice.toLocaleString()}만원`
        : '';

    // 동급매물 시세 정보 (SVG 바)
    const market = fullData.marketPriceData;
    let marketDetail = '';
    if (market && market.median > 0 && price > 0) {
      const RANGE = 0.3; // ±30% 범위
      const deviation = price / market.median - 1;
      const pct = Math.max(0, Math.min(100, (deviation / RANGE) * 50 + 50));
      const absPct = Math.round(Math.abs(deviation) * 100);
      const pinColor = deviation <= -0.05 ? '#4CAF50'
                     : deviation >= 0.15  ? '#F44336'
                     : deviation >= 0.05  ? '#FF9800'
                     : '#FFD700';
      const diffText = Math.abs(deviation) < 0.02 ? '시세 평균 수준'
                     : deviation < 0 ? `시세대비 ${absPct}% 저렴`
                     : `시세대비 ${absPct}% 비쌈`;

      const pinXNum = 10 + (pct / 100) * 180;
      const pinX    = pinXNum.toFixed(1);
      const fillLeft  = Math.min(pinXNum, 100).toFixed(1);
      const fillWidth = Math.abs(pinXNum - 100).toFixed(1);

      marketDetail = `<div class="encar-price-meter">
        <svg class="encar-price-svg" viewBox="0 0 200 36">
          <line x1="10" y1="28" x2="190" y2="28" stroke="rgba(255,255,255,0.12)" stroke-width="2" stroke-linecap="round"/>
          <rect x="${fillLeft}" y="27" width="${fillWidth}" height="2" fill="${pinColor}" opacity="0.5" rx="1"/>
          <line x1="100" y1="22" x2="100" y2="34" stroke="rgba(255,255,255,0.45)" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="${pinX}" y1="19" x2="${pinX}" y2="28" stroke="${pinColor}" stroke-width="2" stroke-linecap="round"/>
          <circle cx="${pinX}" cy="12" r="7" fill="${pinColor}" opacity="0.9"/>
          <circle cx="${(pinXNum - 2.5).toFixed(1)}" cy="9" r="2.5" fill="white" opacity="0.25"/>
        </svg>
        <div class="encar-price-meter-labels">
          <span>← 저렴</span>
          <span>${market.median.toLocaleString()}만원 (${market.count}대)</span>
          <span>비쌈 →</span>
        </div>
        <div class="encar-price-diff-text" style="color:${pinColor}">${diffText}</div>
      </div>`;
    }

    // 연간 평균 주행거리 (출고년월 기준 월단위 계산)
    const { month: registMonth = 0 } = fullData;
    const now = new Date();
    const nowYear = now.getFullYear(), nowMonth = now.getMonth() + 1;
    const ageMonths = (year > 0 && registMonth > 0)
      ? Math.max(1, (nowYear - (2000 + year)) * 12 + (nowMonth - registMonth))
      : Math.max(12, (nowYear - (2000 + (year || 0))) * 12);
    const annualKm = (mileage > 0 && year > 0)
      ? `연평균 ${Math.round(mileage / ageMonths * 12).toLocaleString()}km`
      : '';

    const tooltip = document.createElement('div');
    tooltip.className = 'encar-score-tooltip';
    tooltip.innerHTML = `
      <div class="encar-tooltip-title">${cardData.modelName}</div>
      <div class="encar-tooltip-total">종합점수: <strong>${scoreResult.total}점</strong> (${scoreResult.grade}등급)</div>
      <div class="encar-tooltip-divider"></div>
      <div class="encar-tooltip-row">
        <span>🚗 사고/보험이력</span>
        <span>${Math.round(scoreResult.breakdown.accident)}/${w.accident}</span>
      </div>
      ${accidentText ? `<div class="encar-tooltip-detail">${accidentText}</div>` : ''}
      <div class="encar-tooltip-row">
        <span>📏 주행거리</span>
        <span>${Math.round(scoreResult.breakdown.mileage)}/${w.mileage}</span>
      </div>
      ${annualKm ? `<div class="encar-tooltip-detail">${annualKm}</div>` : ''}
      <div class="encar-tooltip-row">
        <span>💰 가격</span>
        <span>${Math.round(scoreResult.breakdown.price)}/${w.price}</span>
      </div>
      ${priceDetail ? `<div class="encar-tooltip-detail">${priceDetail}</div>` : ''}
      ${marketDetail}
      <div class="encar-tooltip-row">
        <span>🔧 성능점검</span>
        <span>${Math.round(scoreResult.breakdown.inspection)}/${w.inspection}</span>
      </div>
      ${isInspectionPrivate ? `<div class="encar-tooltip-detail">조회불가 · 비공개</div>` : ''}
      <div class="encar-tooltip-row">
        <span>📋 렌트이력</span>
        <span>${Math.round(scoreResult.breakdown.rental)}/${w.rental}</span>
      </div>
      <div class="encar-tooltip-row">
        <span>👤 소유주이력</span>
        <span>${Math.round(scoreResult.breakdown.ownerChanges)}/${w.ownerChanges}</span>
      </div>
    `;
    badge.appendChild(tooltip);

    return badge;
  }


  /**
   * 로딩 뱃지 생성
   */
  function createLoadingBadge() {
    const badge = document.createElement('div');
    badge.className = 'encar-score-badge encar-score-loading';
    badge.innerHTML = `
      <div class="encar-score-spinner"></div>
      <div class="encar-score-number" style="font-size:10px;">분석중</div>
    `;
    return badge;
  }

  /**
   * 단일 차량 카드 처리
   */
  async function processCard(cardEl) {
    const cardData = extractCardData(cardEl);

    if (!cardData.carId) {
      console.warn('[EncarScore] carId를 추출할 수 없는 카드:', cardEl);
      return;
    }

    // 카드 컨테이너에 상대 위치 설정
    const parentEl = cardEl.closest('div') || cardEl;
    if (getComputedStyle(parentEl).position === 'static') {
      parentEl.style.position = 'relative';
    }

    // 로딩 배지 표시
    const loadingBadge = createLoadingBadge();
    parentEl.appendChild(loadingBadge);

    try {
      // 상세 데이터 가져오기 (rate limiting)
      await delay(Math.random() * 500 + 200);
      const detailData = await DetailParser.fetchDetailData(cardData.carId);

      // 기본 + 상세 데이터 합치기
      const fullData = { ...cardData, ...detailData };

      // 사용자 가중치 & 설정 불러오기
      const weights = await getStoredWeights();
      const priceMode = await getStoredPriceMode();

      // 점수 계산
      const scoreResult = EncarScoring.calculateScore(fullData, weights, { priceMode });

      // 로딩 배지 제거 → 점수 배지 표시
      loadingBadge.remove();
      const scoreBadge = createScoreBadge(scoreResult, cardData, weights, fullData);
      parentEl.appendChild(scoreBadge);

      // 점수를 컨테이너에 저장 (필터링에 사용)
      parentEl.dataset.encarScore = scoreResult.total;

      // 현재 필터 조건 적용
      const storedMin = parseInt(await getStoredMinScore(), 10) || 0;
      if (storedMin > 0 && scoreResult.total < storedMin) {
        parentEl.style.display = 'none';
      }

      console.log(`[EncarScore] ${cardData.modelName}: ${scoreResult.total}점 (${scoreResult.grade})`, scoreResult.breakdown);
    } catch (error) {
      console.error(`[EncarScore] 카드 처리 실패: ${cardData.carId}`, error);
      loadingBadge.remove();

      // 에러 배지 표시
      const errorBadge = document.createElement('div');
      errorBadge.className = 'encar-score-badge encar-score-error';
      errorBadge.innerHTML = `<div class="encar-score-number" style="font-size:10px;">오류</div>`;
      parentEl.appendChild(errorBadge);
    }
  }

  /**
   * 모든 차량 카드 스캔 및 처리
   */
  async function scanAndProcess() {
    if (isProcessing) return;
    isProcessing = true;

    try {
      // 차량 카드 선택 (여러 셀렉터 시도)
      const selectors = [
        'a[class*="link_item"]',
        'a[class*="ItemBigImage"]',
        'a[class*="ItemSmallImage"]',
        'a[class*="item_link"]'
      ];

      let cards = [];
      for (const selector of selectors) {
        cards = document.querySelectorAll(selector);
        if (cards.length > 0) break;
      }

      if (cards.length === 0) {
        console.log('[EncarScore] 차량 카드를 찾을 수 없습니다.');
        isProcessing = false;
        return;
      }

      console.log(`[EncarScore] ${cards.length}개 차량 카드 발견`);

      // 동시 처리 수 제한 (서버 부하 방지)
      const BATCH_SIZE = 3;
      const cardsArray = Array.from(cards);

      for (let i = 0; i < cardsArray.length; i += BATCH_SIZE) {
        const batch = cardsArray.slice(i, i + BATCH_SIZE).filter(card => {
          const id = (card.getAttribute('href') || '').match(/detail\/(\d+)/)?.[1];
          if (!id || processedCards.has(id)) return false;
          processedCards.add(id);
          return true;
        });

        await Promise.all(batch.map(card => processCard(card)));
      }
    } catch (error) {
      console.error('[EncarScore] 스캔 오류:', error);
    }

    isProcessing = false;
  }

  /**
   * 저장된 가중치 불러오기
   */
  function getStoredWeights() {
    return new Promise((resolve) => {
      if (chrome?.storage?.local) {
        chrome.storage.local.get(['weights'], (result) => {
          resolve(result.weights || EncarScoring.DEFAULT_WEIGHTS);
        });
      } else {
        resolve(EncarScoring.DEFAULT_WEIGHTS);
      }
    });
  }

  /**
   * 저장된 최소 점수 불러오기
   */
  function getStoredMinScore() {
    return new Promise((resolve) => {
      if (chrome?.storage?.local) {
        chrome.storage.local.get(['minScore'], (result) => resolve(result.minScore ?? 0));
      } else {
        resolve(0);
      }
    });
  }

  /**
   * 저장된 가격 평가 모드 불러오기
   */
  function getStoredPriceMode() {
    return new Promise((resolve) => {
      if (chrome?.storage?.local) {
        chrome.storage.local.get(['priceMode'], (result) => resolve(result.priceMode ?? 'relative'));
      } else {
        resolve('relative');
      }
    });
  }

  /**
   * 딜레이 유틸리티
   */
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * MutationObserver로 동적 로드 감지
   */
  function observeDynamicContent() {
    const observer = new MutationObserver((mutations) => {
      let hasNewCards = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && (
              node.matches?.('a[class*="link_item"]') ||
              node.querySelector?.('a[class*="link_item"]')
            )) {
              hasNewCards = true;
              break;
            }
          }
        }
        if (hasNewCards) break;
      }

      if (hasNewCards) {
        console.log('[EncarScore] 새로운 차량 카드 감지');
        setTimeout(scanAndProcess, 500);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    return observer;
  }

  /**
   * 메시지 리스너 (팝업에서 요청)
   */
  chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (message.type === 'RESCAN') {
      processedCards.clear();
      document.querySelectorAll('.encar-score-badge').forEach(el => el.remove());
      // 필터 조건도 리셋
      document.querySelectorAll('[data-encar-score]').forEach(el => {
        el.removeAttribute('data-encar-score');
        el.style.display = '';
      });
      scanAndProcess();
      sendResponse({ success: true });
    }
    if (message.type === 'GET_STATUS') {
      sendResponse({
        processedCount: processedCards.size,
        isProcessing
      });
    }
    if (message.type === 'APPLY_FILTER') {
      const minScore = parseInt(message.minScore, 10) || 0;
      document.querySelectorAll('[data-encar-score]').forEach(el => {
        const score = parseInt(el.dataset.encarScore, 10);
        el.style.display = (minScore > 0 && score < minScore) ? 'none' : '';
      });
      sendResponse({ success: true, applied: true });
    }
    return true;
  });

  /**
   * 상세 페이지 여부 확인
   */
  function isDetailPage() {
    return /\/cars\/detail\/\d+/.test(location.pathname);
  }

  /**
   * 상세 페이지 carId 추출 (URL 경로에서)
   */
  function getDetailCarId() {
    const match = location.pathname.match(/\/detail\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * 상세 페이지 점수 오버레이 표시 (fixed 위치로 body에 직접 붙임)
   */
  async function processDetailPage() {
    const carId = getDetailCarId();
    if (!carId) return;

    if (document.querySelector('.encar-score-badge')) return; // 중복 방지

    await delay(1500); // React 렌더링 대기

    const loadingBadge = createLoadingBadge();
    loadingBadge.style.cssText += '; position: fixed !important; bottom: 24px; right: 24px; width: 72px; height: 72px; z-index: 99999;';
    document.body.appendChild(loadingBadge);

    try {
      const detailData = await DetailParser.fetchDetailData(carId);

      const titleEl = document.querySelector('h1');
      const modelName = titleEl?.textContent?.trim().split('\n')[0] || document.title;

      const fullData = { carId, modelName, ...detailData };
      const weights = await getStoredWeights();
      const priceMode = await getStoredPriceMode();
      const scoreResult = EncarScoring.calculateScore(fullData, weights, { priceMode });

      loadingBadge.remove();
      const scoreBadge = createScoreBadge(scoreResult, { modelName }, weights, fullData);
      scoreBadge.style.cssText += '; position: fixed !important; bottom: 24px; right: 24px; width: 72px; height: 72px; z-index: 99999;';
      document.body.appendChild(scoreBadge);

      console.log(`[EncarScore] 상세페이지 ${carId}: ${scoreResult.total}점 (${scoreResult.grade})`, scoreResult.breakdown);
    } catch (error) {
      console.error('[EncarScore] 상세페이지 처리 실패:', carId, error);
      loadingBadge.remove();
    }
  }

  // 초기 실행
  if (isDetailPage()) {
    await processDetailPage();
    console.log('[EncarScore] 상세페이지 스캔 완료');
  } else {
    await delay(1500); // 페이지 로드 대기
    await scanAndProcess();
    observeDynamicContent();
    console.log('[EncarScore] 초기 스캔 완료');
  }
})();
