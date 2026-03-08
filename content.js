/**
 * 엔카 중고차 품질 점수 - Content Script
 * 리스트 페이지에서 차량 데이터를 추출하고 점수 배지를 삽입
 */

(async function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // 1. 유틸리티
  // ═══════════════════════════════════════════════════════════════

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const past = new Date(dateStr);
    if (isNaN(past.getTime())) return '';
    const diffMin = Math.floor((Date.now() - past.getTime()) / 60000);
    if (diffMin < 1)   return '방금 전';
    if (diffMin < 60)  return `${diffMin}분 전`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}시간 전`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 30)  return `${diffDay}일 전`;
    return `${Math.floor(diffDay / 30)}개월 전`;
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. 스토리지
  // ═══════════════════════════════════════════════════════════════

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

  function getStoredMinScore() {
    return new Promise((resolve) => {
      if (chrome?.storage?.local) {
        chrome.storage.local.get(['minScore'], (result) => resolve(result.minScore ?? 0));
      } else {
        resolve(0);
      }
    });
  }

  function getStoredPriceMode() {
    return new Promise((resolve) => {
      if (chrome?.storage?.local) {
        chrome.storage.local.get(['priceMode'], (result) => resolve(result.priceMode ?? 'relative'));
      } else {
        resolve('relative');
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. DOM 파싱 / 데이터 추출
  // ═══════════════════════════════════════════════════════════════

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

  function isDetailPage() {
    return /\/cars\/detail\/\d+/.test(location.pathname);
  }

  function getDetailCarId() {
    const match = location.pathname.match(/\/detail\/(\d+)/);
    return match ? match[1] : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. UI 렌더링
  // ═══════════════════════════════════════════════════════════════

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
            ownerChangeCount = 0,
            isInspectionPrivate = false,
            hasDiagnosis = false, diagnosisTier = null,
            firstAdvertisedDateTime = null,
            dealerJoinedDatetime = null, dealerTotalSales = 0,
            dealerAvgScore = null, dealerName = '', dealerFirmName = '' } = fullData;
    const registedAgo = formatRelativeTime(firstAdvertisedDateTime);

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
      const deviation = price / market.median - 1;
      const absPct = Math.round(Math.abs(deviation) * 100);
      const pinColor = deviation <= -0.05 ? '#4CAF50'
                     : deviation >= 0.15  ? '#F44336'
                     : deviation >= 0.05  ? '#FF9800'
                     : '#FFD700';
      const diffText = Math.abs(deviation) < 0.02 ? '시세 평균 수준'
                     : deviation < 0 ? `시세대비 ${absPct}% 저렴`
                     : `시세대비 ${absPct}% 비쌈`;

      // 신차가를 오른쪽 끝 기준으로 스케일 설정
      const hasOrigin = originPrice > 0 && originPrice > market.median * 1.05;
      let pricePct;
      if (hasOrigin) {
        // [2*median - originPrice ... median(center) ... originPrice(right)]
        const leftBound = 2 * market.median - originPrice;
        pricePct = Math.max(0, Math.min(100, (price - leftBound) / (originPrice - leftBound) * 100));
      } else {
        pricePct = Math.max(0, Math.min(100, (deviation / 0.3) * 50 + 50));
      }

      const priceXNum = 10 + (pricePct / 100) * 180;
      const priceX    = priceXNum.toFixed(1);
      const fillLeft  = Math.min(priceXNum, 100).toFixed(1);
      const fillWidth = Math.abs(priceXNum - 100).toFixed(1);

      // 신차가 pin (오른쪽 끝 고정, 회색)
      const originPinSvg = hasOrigin ? `
          <line x1="190" y1="26" x2="190" y2="34" stroke="rgba(200,200,200,0.7)" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="190" cy="20" r="6" fill="rgba(180,180,180,0.6)"/>` : '';

      // 라벨 오른쪽: 신차가 있으면 신차가, 없으면 "비쌈 →"
      const rightLabel = hasOrigin ? `신차가 ${originPrice.toLocaleString()}만원` : '비쌈 →';

      marketDetail = `<div class="encar-price-meter">
        <svg class="encar-price-svg" viewBox="0 0 200 42">
          <line x1="10" y1="34" x2="190" y2="34" stroke="rgba(255,255,255,0.12)" stroke-width="2" stroke-linecap="round"/>
          <rect x="${fillLeft}" y="33" width="${fillWidth}" height="2" fill="${pinColor}" opacity="0.5" rx="1"/>
          ${originPinSvg}
          <line x1="100" y1="27" x2="100" y2="34" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="100" cy="21" r="6" fill="rgba(255,255,255,0.35)"/>
          <line x1="${priceX}" y1="24" x2="${priceX}" y2="34" stroke="${pinColor}" stroke-width="2" stroke-linecap="round"/>
          <circle cx="${priceX}" cy="15" r="8" fill="${pinColor}" opacity="0.9"/>
          <circle cx="${(priceXNum - 3).toFixed(1)}" cy="11" r="3" fill="white" opacity="0.25"/>
        </svg>
        <div class="encar-price-meter-labels">
          <span>← 저렴</span>
          <span>${market.median.toLocaleString()}만원 (${market.count}대)</span>
          <span>${rightLabel}</span>
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
    const annualKm = (mileage > 0 && ageMonths > 0)
      ? `연평균 ${Math.round(mileage / ageMonths * 12).toLocaleString()}km`
      : '';

    // 딜러 정보 텍스트 (가입일 + 총 판매대수)
    let dealerText = '';
    if (dealerName && dealerJoinedDatetime) {
      const joinMatch = dealerJoinedDatetime.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (joinMatch) {
         const dYear = joinMatch[1];
         const dMonth = joinMatch[2];
         const dDay = joinMatch[3];
         dealerText = `판매자 가입일: ${dYear}/${dMonth}/${dDay} · 누적판매 ${dealerTotalSales}대`;
      }
    }
    const dealerFullName = [dealerFirmName, dealerName].filter(Boolean).join(' ') || '판매자';

    const tooltip = document.createElement('div');
    tooltip.className = 'encar-score-tooltip';
    tooltip.innerHTML = `
      <div class="encar-tooltip-title">${cardData.modelName}</div>
      ${registedAgo ? `<div class="encar-tooltip-registed">${registedAgo} 등록</div>` : ''}
      <div class="encar-tooltip-total">종합점수: <strong>${scoreResult.total}점</strong> (${scoreResult.grade}등급)</div>
      ${scoreResult.penalty ? `<div style="color:#ff5252; font-size:12px; margin-top:4px;">⚠️ 미공개 항목 페널티 (-40점)</div>` : ''}
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
      ${isInspectionPrivate ? `<div class="encar-tooltip-detail">조회불가 · 비공개</div>`
        : hasDiagnosis ? `<div class="encar-tooltip-detail">${
            diagnosisTier === 'PLUSPLUS' ? '엔카진단++ (+4점)'
          : diagnosisTier === 'PLUS'    ? '엔카진단+'
          : '엔카진단'
        }</div>` : `<div class="encar-tooltip-detail" style="color:#ffcc00">엔카진단 미적용 (-5점)</div>`}
      <div class="encar-tooltip-row">
        <span>📋 렌트이력</span>
        <span>${Math.round(scoreResult.breakdown.rental)}/${w.rental}</span>
      </div>
      <div class="encar-tooltip-row">
        <span>👤 소유주/판매자 이력</span>
        <span>${Math.round(scoreResult.breakdown.ownerChanges)}/${w.ownerChanges}</span>
      </div>
      <div class="encar-tooltip-detail">소유자 변경: ${ownerChangeCount}회</div>
      ${dealerAvgScore ? `
      <div class="encar-tooltip-divider"></div>
      <div class="encar-tooltip-row">
        <span>🏪 ${dealerFullName} 평균</span>
        <span style="color:${EncarScoring.getGradeColor(EncarScoring.getGrade(dealerAvgScore.avg))};font-weight:600">${dealerAvgScore.avg}점</span>
      </div>
      <div class="encar-tooltip-detail">최근 ${dealerAvgScore.count}개 매물 기준</div>` : ''}
      ${dealerText ? `<div class="encar-tooltip-detail">${dealerText}</div>` : ''}
    `;

    // 툴팁이 잘리는 현상(overflow: hidden)을 방지하기 위해 body에 직접 삽입하여 fixed 좌표로 렌더링
    badge.addEventListener('mouseenter', () => {
      document.body.appendChild(tooltip);
      tooltip.style.visibility = 'hidden';
      tooltip.style.display = 'block';

      const rect = badge.getBoundingClientRect();
      const tooltipHeight = tooltip.offsetHeight;
      const tooltipWidth = tooltip.offsetWidth;

      // 뱃지 상단에 위치하도록 계산
      let top = rect.top - tooltipHeight - 8;
      // 뱃지 우측에 맞춰서 표시 (패딩 고려)
      let left = rect.right - tooltipWidth + 12;

      // 만약 위쪽이 브라우저 화면 밖으로 나간다면 뱃지 아래로 띄움
      if (top < 10) {
        top = rect.bottom + 8;
      }

      // 만약 왼쪽이 브라우저 화면 밖으로 나간다면 강제 조정
      if (left < 10) {
        left = 10;
      }

      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
      tooltip.style.right = 'auto';
      tooltip.style.bottom = 'auto';
      tooltip.style.visibility = 'visible';
    });

    badge.addEventListener('mouseleave', () => {
      if (tooltip.parentNode) {
        tooltip.parentNode.removeChild(tooltip);
      }
    });

    return badge;
  }

  function createLoadingBadge() {
    const badge = document.createElement('div');
    badge.className = 'encar-score-badge encar-score-loading';
    badge.innerHTML = `
      <div class="encar-score-spinner"></div>
      <div class="encar-score-number" style="font-size:10px;">분석중</div>
    `;
    return badge;
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. 카드 처리 & 페이지 로직
  // ═══════════════════════════════════════════════════════════════

  const processedCards = new Set();
  let isProcessing = false;

  const cardObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const card = entry.target;
        observer.unobserve(card);
        processCard(card).catch(err => console.error('[EncarScore] 카드 지연 처리 오류:', err));
      }
    });
  }, {
    rootMargin: '200px 0px',
    threshold: 0.1
  });

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

      // 뷰포트 스크롤에 따른 Lazy-load 등록
      const cardsArray = Array.from(cards);
      cardsArray.forEach(card => {
        const id = (card.getAttribute('href') || '').match(/detail\/(\d+)/)?.[1];
        if (!id || processedCards.has(id)) return;

        // 처리/관찰 대상 집합에 추가 (중복 방지)
        processedCards.add(id);

        // 옵저버에 카드를 등록하여, 사용자가 스크롤해서 보일 때 processCard() 실행
        cardObserver.observe(card);
      });
    } catch (error) {
      console.error('[EncarScore] 스캔 오류:', error);
    }

    isProcessing = false;
  }

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

  // ═══════════════════════════════════════════════════════════════
  // 6. 메시지 핸들러 & 초기화
  // ═══════════════════════════════════════════════════════════════

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

  // 초기 실행
  console.log('[EncarScore] 크롬 익스텐션 로드됨');

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
