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

  function createOwnerTimeline(data, now = new Date()) {
    if (data.isInsurancePrivate) return '<div class="encar-tooltip-detail">소유주·보험이력 조회 불가</div>';
    const parseDate = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const [year, month, day] = value.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
        ? date.getTime() : null;
    };
    const start = parseDate(data.firstRegistrationDate);
    const end = now.getTime();
    if (start === null || start >= end) return '<div class="encar-tooltip-detail">최초 등록일 정보 없음</div>';
    const dates = (Array.isArray(data.ownerChanges) ? data.ownerChanges : [])
      .map(date => ({ date, time: parseDate(date) }))
      .filter(item => item.time !== null && item.time >= start && item.time <= end)
      .sort((a, b) => a.time - b.time);
    const history = Array.isArray(data.insuranceHistory) ? data.insuranceHistory : [];
    const insurance = history
      .filter(item => item && typeof item.date === 'string')
      .map(item => ({ ...item, time: parseDate(item.date) }))
      .filter(item => item.time !== null && item.time >= start && item.time <= end)
      .sort((a, b) => a.time - b.time);
    const unavailableRanges = (Array.isArray(data.unavailablePeriods) ? data.unavailablePeriods : [])
      .map(value => {
        const match = String(value || '').trim().match(
          /^(\d{4})[-/.]?(\d{2})(?:[-/.]?\d{2})?\s*[~～]\s*(\d{4})[-/.]?(\d{2})(?:[-/.]?\d{2})?$/
        );
        if (!match) return null;
        const [, fromYearText, fromMonthText, toYearText, toMonthText] = match;
        const fromYear = Number(fromYearText), fromMonth = Number(fromMonthText);
        const toYear = Number(toYearText), toMonth = Number(toMonthText);
        if (fromMonth < 1 || fromMonth > 12 || toMonth < 1 || toMonth > 12) return null;
        const rangeStart = new Date(fromYear, fromMonth - 1, 1).getTime();
        const rangeEnd = new Date(toYear, toMonth, 1).getTime();
        if (rangeStart >= rangeEnd) return null;
        return {
          start: rangeStart,
          end: rangeEnd,
          label: `${fromYearText}.${fromMonthText}~${toYearText}.${toMonthText}`
        };
      })
      .filter(Boolean);
    const missing = dates.length < Number(data.ownerChangeCount || 0);
    const insuranceMissing = insurance.length < Math.max(history.length, Number(data.insuranceCount) || 0);
    const today = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    const boundaries = [
      { time: start, date: data.firstRegistrationDate },
      ...dates,
      { time: end, date: today.replaceAll('.', '-') }
    ];
    const colors = ['#4CAF50', '#CDDC39', '#FF9800', '#F44336', '#B73229', '#7A221B', '#3D110E', '#000000'];
    const calcX = time => 34 + (time - start) / (end - start) * 344;
    const parsedOriginPrice = Number(data.originPrice);
    const originPriceWon = Number.isFinite(parsedOriginPrice) && parsedOriginPrice > 0
      ? parsedOriginPrice * 10000
      : null;
    const rows = boundaries.slice(0, -1).map((boundary, index) => {
      const until = boundaries[index + 1];
      const last = index === boundaries.length - 2;
      // 변경일 당일은 시각 정보가 없으므로 변경 후 구간에 배치한다.
      const events = insurance.filter(item =>
        item.time >= boundary.time && (last ? item.time <= until.time : item.time < until.time)
      );
      const marks = events.map(item => {
        const x = calcX(item.time);
        const insuranceAmountWon = Number.isFinite(item.amount) && item.amount >= 0 ? item.amount : null;
        const laborCostWon = Number.isFinite(item.laborCost) && item.laborCost >= 0 ? item.laborCost : null;
        const amount = insuranceAmountWon !== null
          ? `${(insuranceAmountWon / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}만원`
          : '금액 미제공';
        const laborAmount = laborCostWon !== null
          ? `${(laborCostWon / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}만원`
          : '미제공';
        const isMajorAccident = originPriceWon !== null && (
          (insuranceAmountWon !== null && insuranceAmountWon * 100 >= originPriceWon * 15) ||
          (laborCostWon !== null && laborCostWon * 100 >= originPriceWon * 7)
        );
        return { ...item, x, amount, laborAmount, isMajorAccident };
      });
      const unavailable = unavailableRanges.map(range => {
        const overlapStart = Math.max(boundary.time, range.start);
        const overlapEnd = Math.min(until.time, range.end);
        return overlapStart < overlapEnd
          ? { ...range, x1: calcX(overlapStart), x2: calcX(overlapEnd) }
          : null;
      }).filter(Boolean);
      const y = 12;
      return { index, y, x1: calcX(boundary.time), x2: calcX(until.time), boundary, until, last, marks, unavailable };
    });
    const createStarPoints = (centerX, centerY, outerRadius = 5, innerRadius = 2.3) =>
      Array.from({ length: 10 }, (_, index) => {
        const radius = index % 2 === 0 ? outerRadius : innerRadius;
        const angle = -Math.PI / 2 + index * Math.PI / 5;
        return `${(centerX + Math.cos(angle) * radius).toFixed(1)},${(centerY + Math.sin(angle) * radius).toFixed(1)}`;
      }).join(' ');
    const steps = rows.map(row => {
      const color = colors[Math.min(row.index, 7)];
      const unavailableSegments = row.unavailable.map(range =>
        `<line data-unavailable-period="${range.label}" x1="${range.x1.toFixed(1)}" y1="${row.y}" x2="${range.x2.toFixed(1)}" y2="${row.y}" stroke="#757575" stroke-width="6"><title>정보제공 불가기간 ${range.label}</title></line>`
      ).join('');
      const pins = row.marks.map(item => {
        const outerRadius = item.isMajorAccident ? 11 : 5;
        const innerRadius = item.isMajorAccident ? 5 : 2.3;
        const severity = item.isMajorAccident ? '큰 사고' : '작은 사고';
        const fill = item.isMajorAccident ? '#FF3B30' : '#FFC107';
        const strokeWidth = item.isMajorAccident ? 1.3 : 0.9;
        return `<polygon data-accident-date="${item.date}" data-accident-severity="${item.isMajorAccident ? 'major' : 'minor'}" points="${createStarPoints(item.x, row.y, outerRadius, innerRadius)}" fill="${fill}" stroke="#fff" stroke-width="${strokeWidth}" stroke-linejoin="round"><title>${severity} · 보험이력 ${item.date} · 보험지급금 ${item.amount} · 공임비 ${item.laborAmount}</title></polygon>`;
      }).join('');
      return `<g data-owner-period="${row.index}">
        <text x="12" y="${row.y + 4}" text-anchor="middle">${row.index + 1}</text>
        <line x1="${row.x1.toFixed(1)}" y1="${row.y}" x2="${row.x2.toFixed(1)}" y2="${row.y}" stroke="#90a4ae" stroke-width="8"/>
        <line x1="${row.x1.toFixed(1)}" y1="${row.y}" x2="${row.x2.toFixed(1)}" y2="${row.y}" stroke="${color}" stroke-width="6"/>
        ${unavailableSegments}
        <circle cx="${row.x1.toFixed(1)}" cy="${row.y}" r="4" fill="${color}" stroke="#cfd8dc"/>
        <circle cx="${row.x2.toFixed(1)}" cy="${row.y}" r="3" fill="${color}" stroke="#cfd8dc"/>
        ${pins}
      </g>`;
    });
    const formatOwnershipDuration = (from, to) => {
      const first = new Date(from);
      const last = new Date(to);
      let months = (last.getFullYear() - first.getFullYear()) * 12 + last.getMonth() - first.getMonth();
      // 월말에 시작한 기간은 대상 월의 마지막 날을 한 달 경과일로 계산한다.
      const anniversaryDay = Math.min(first.getDate(), new Date(last.getFullYear(), last.getMonth() + 1, 0).getDate());
      if (last.getDate() < anniversaryDay) months--;
      if (months >= 1) return `${months}개월`;
      const days = Math.round((Date.UTC(last.getFullYear(), last.getMonth(), last.getDate())
        - Date.UTC(first.getFullYear(), first.getMonth(), first.getDate())) / 86400000);
      return `${Math.max(0, days)}일`;
    };
    const details = rows.map(row => {
      const title = missing ? `확인 기간 ${row.index + 1}` : row.index === 0 ? '최초' : '';
      const range = `${row.boundary.date.replaceAll('-', '.')} ~ ${row.last ? '현재' : row.until.date.replaceAll('-', '.')}`;
      const duration = formatOwnershipDuration(row.boundary.time, row.until.time);
      const events = row.marks.map(item => `${item.date.slice(0, 7).replace('-', '.')} · ${item.amount}`).join(' / ');
      return `<div class="encar-owner-period-block">
        <svg viewBox="0 0 390 24" role="img" aria-label="${row.index + 1}번 소유 기간 타임라인">${steps[row.index]}</svg>
        <div class="encar-owner-summary"><div class="encar-owner-summary-row"><span class="encar-owner-period-number">${row.index + 1}</span><div><span>${title ? `${title} · ` : ''}<strong>${duration}</strong> · ${range}</span>${events ? `<div class="encar-owner-insurance-list">${events}</div>` : ''}</div></div></div>
      </div>`;
    }).join('');
    return `<div class="encar-owner-timeline">
      <div class="encar-tooltip-detail">★ 보험이력 · 큰 사고는 큰 빨간 별표 · 지급금(만원)${unavailableRanges.length ? ' · 회색: 정보제공 불가' : ''}</div>
      ${details}
      ${missing ? '<div class="encar-tooltip-detail">일부 변경일 누락 · 소유 기간 구분이 불완전할 수 있음</div>' : ''}
      ${insuranceMissing ? '<div class="encar-tooltip-detail">일부 보험이력 일자 정보 없음</div>' : ''}
      ${dates.some(change => insurance.some(item => item.time === change.time)) ? '<div class="encar-tooltip-detail">변경일 당일 보험이력은 변경 후 구간에 표시</div>' : ''}
    </div>`;
  }

  /**
   * depreciationCurve(선택): 모델 그룹 회귀로 추정한 감가곡선
   *   priceAt(경과연수) → 곡선 가격, ageShift: 정수 경과연수 → 코호트 평균 경과연수 보정,
   *   carAge/carPrice: 현재 차량 위치
   */
  function createYearlyMarketChart(yearlyMarketData, carYear, originPrice = 0, depreciationCurve = null) {
    const points = (yearlyMarketData?.points || [])
      .filter(point =>
        Number.isInteger(point.age) && point.age >= 0 &&
        Number.isFinite(point.avgPrice) && point.avgPrice > 0 &&
        Number.isFinite(point.count) && point.count > 0
      )
      .sort((a, b) => a.age - b.age);
    if (points.length === 0) return '';

    const currentCalendarYear = new Date().getFullYear();

    const chartWidth = 280;
    const chartCenter = chartWidth / 2;
    const priceAxisX = chartWidth - 2;
    const plotLeft = 24;
    const plotRight = 256;
    const plotTop = 11;
    const baselineY = 54;
    const maxAge = Math.max(
      ...points.map(point => point.age)
    );
    const maxCount = Math.max(...points.map(point => point.count));
    const parsedOriginPrice = Number(originPrice);
    const newCarPrice = Number.isFinite(parsedOriginPrice) && parsedOriginPrice > 0
      ? parsedOriginPrice
      : null;
    const avgPrices = [
      ...points.map(point => point.avgPrice)
    ];
    // 추정 곡선은 판매 중 평균가와 같은 x 범위(0년 ~ 가장 오래된 연식)에서 1/4년 간격으로 그린다.
    const curveSamples = depreciationCurve
      ? Array.from({ length: maxAge * 4 + 1 }, (_, i) => {
          const age = i / 4;
          return { age, price: depreciationCurve.priceAt(Math.max(0, age + depreciationCurve.ageShift)) };
        }).filter(sample => Number.isFinite(sample.price) && sample.price > 0)
      : [];
    const carCohortAge = depreciationCurve ? depreciationCurve.carAge - depreciationCurve.ageShift : null;
    const showCarPoint = depreciationCurve && depreciationCurve.carPrice > 0 &&
      carCohortAge >= -0.5 && carCohortAge <= maxAge + 0.5;
    const scalePrices = [
      ...avgPrices,
      ...(newCarPrice ? [newCarPrice] : []),
      ...curveSamples.map(sample => sample.price),
      ...(showCarPoint ? [depreciationCurve.carPrice] : [])
    ];
    const rawMinPrice = Math.min(...scalePrices);
    const rawMaxPrice = Math.max(...scalePrices);
    const pricePadding = Math.max(100, (rawMaxPrice - rawMinPrice) * 0.12);
    const minPrice = Math.max(0, Math.floor((rawMinPrice - pricePadding) / 100) * 100);
    let maxPrice = Math.ceil((rawMaxPrice + pricePadding) / 100) * 100;
    if (maxPrice <= minPrice) maxPrice = minPrice + 100;

    // 신차가가 있으면 가장 왼쪽을 신차가 전용 칸으로 비우고 연식별 데이터는 그 오른쪽부터 배치한다.
    const ageOffset = newCarPrice ? 1 : 0;
    const xDenominator = Math.max(1, maxAge + ageOffset);
    const calcAgeX = age => plotLeft + ((age + ageOffset) / xDenominator) * (plotRight - plotLeft);
    const calcCountY = count => baselineY - (count / maxCount) * (baselineY - plotTop);
    const calcPriceY = price => {
      const ratio = (price - minPrice) / (maxPrice - minPrice);
      return baselineY - Math.max(0, Math.min(1, ratio)) * (baselineY - plotTop);
    };

    // x축은 1년 단위 좌표를 유지하되, 연식이 많으면 눈금 문자만 간격을 띄워 표시한다.
    const slotWidth = (plotRight - plotLeft) / Math.max(1, maxAge + ageOffset + 1);
    const barWidth = Math.max(2.5, Math.min(11, slotWidth * 0.68));
    const ageLabelStep = Math.max(1, Math.ceil((maxAge + 1) / 11));
    const compactPriceLabels = slotWidth < 18;
    const livePriceLabelSize = compactPriceLabels ? 6.3 : 7.2;
    const pointsByAge = new Map(points.map(point => [point.age, point]));

    const barsSvg = points.map(point => {
      const x = calcAgeX(point.age);
      const y = calcCountY(point.count);
      return `<rect x="${(x - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(baselineY - y).toFixed(1)}" rx="1.5" fill="rgba(100,181,246,0.55)">
        <title>출고 ${point.age}년 · ${point.year}년식 · ${point.count}대 · 평균 ${point.avgPrice.toLocaleString()}만원</title>
      </rect>`;
    }).join('');

    const priceLinePoints = [
      ...(newCarPrice ? [{ x: plotLeft, price: newCarPrice }] : []),
      ...points.map(point => ({ x: calcAgeX(point.age), price: point.avgPrice }))
    ];
    const priceLinePath = priceLinePoints.map((point, index) => {
      const command = index === 0 ? 'M' : 'L';
      return `${command} ${point.x.toFixed(1)} ${calcPriceY(point.price).toFixed(1)}`;
    }).join(' ');

    const pricePointElements = points.map(point => {
      const x = calcAgeX(point.age);
      const y = calcPriceY(point.avgPrice);
      const label = compactPriceLabels
        ? `${(point.avgPrice / 1000).toFixed(1)}천`
        : point.avgPrice.toLocaleString();
      const labelY = Math.max(7, y - 3.5);
      const depreciation = newCarPrice
        ? Math.round((1 - point.avgPrice / newCarPrice) * 100)
        : null;
      const depreciationText = depreciation === null
        ? ''
        : depreciation >= 0
          ? ` · 신차가 대비 ${depreciation}% 감가`
          : ` · 신차가보다 ${Math.abs(depreciation)}% 높음`;
      return {
        circle: `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.7" fill="#FFD54F" stroke="#fff" stroke-width="0.8">
          <title>출고 ${point.age}년 · 평균 ${point.avgPrice.toLocaleString()}만원${depreciationText}</title>
        </circle>`,
        label: `<text x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" fill="#FFD54F" stroke="rgba(20,20,28,0.92)" stroke-width="1.5" paint-order="stroke" text-anchor="middle" font-size="${livePriceLabelSize}" font-weight="700">${label}</text>`
      };
    });
    const pricePointsSvg = pricePointElements.map(element => element.circle).join('');
    const priceLabelsSvg = pricePointElements.map(element => element.label).join('');

    // 선택옵션까지 포함한 신차가는 별도 점 없이 감가선의 가장 왼쪽 시작값으로 표시한다.
    const newCarPriceSvg = newCarPrice ? (() => {
      const y = calcPriceY(newCarPrice);
      const labelY = Math.max(7, y - 3.5);
      const priceLabel = compactPriceLabels
        ? `${(newCarPrice / 1000).toFixed(1)}천`
        : newCarPrice.toLocaleString();
      return `<text x="${plotLeft}" y="${labelY.toFixed(1)}" fill="#CFD8DC" stroke="rgba(20,20,28,0.95)" stroke-width="1.8" paint-order="stroke" text-anchor="middle" font-size="${livePriceLabelSize}" font-weight="700"><title>신차가 ${newCarPrice.toLocaleString()}만원</title>${priceLabel}</text>
        <text x="${plotLeft}" y="66" fill="#CFD8DC" text-anchor="middle" font-size="6.2" font-weight="700">신차가</text>`;
    })() : '';

    const ageLabelsSvg = Array.from({ length: maxAge + 1 }, (_, age) => {
      if (age % ageLabelStep !== 0 && age !== maxAge) return '';
      const point = pointsByAge.get(age);
      const color = point ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.28)';
      const calendarYear = point?.year || currentCalendarYear - age;
      const shortYear = String(calendarYear).slice(-2);
      const x = calcAgeX(age).toFixed(1);
      return `<text x="${x}" y="62" fill="${color}" text-anchor="middle" font-size="7">${age}년</text>
        <text x="${x}" y="69" fill="${color}" text-anchor="middle" font-size="6.3">${shortYear}</text>`;
    }).join('');

    const fullCarYear = carYear > 0 ? 2000 + carYear : 0;
    const currentCarAge = fullCarYear > 0 ? Math.max(0, new Date().getFullYear() - fullCarYear) : null;
    const currentAgeMarker = currentCarAge !== null && currentCarAge <= maxAge
      ? `<line x1="${calcAgeX(currentCarAge).toFixed(1)}" y1="${plotTop}" x2="${calcAgeX(currentCarAge).toFixed(1)}" y2="${baselineY}" stroke="rgba(76,175,80,0.8)" stroke-width="1" stroke-dasharray="2 2"/>
         <text x="${calcAgeX(currentCarAge).toFixed(1)}" y="9" fill="#81C784" text-anchor="middle" font-size="6.2" font-weight="700">현재 차량</text>`
      : '';

    // 추정 감가곡선(점선)과 현재 차량 가격(점). 곡선은 판매 중 평균가 수준에 맞춰 그린다.
    const curvePath = curveSamples.map((sample, index) =>
      `${index === 0 ? 'M' : 'L'} ${calcAgeX(sample.age).toFixed(1)} ${calcPriceY(sample.price).toFixed(1)}`
    ).join(' ');
    const curveSvg = curveSamples.length > 1
      ? `<path d="${curvePath}" fill="none" stroke="#FF8A65" stroke-width="1.4" stroke-dasharray="3 2" stroke-linejoin="round" stroke-linecap="round"><title>추정 감가곡선 (평균 주행 가정)</title></path>`
      : '';
    const carPointSvg = showCarPoint
      ? `<circle cx="${calcAgeX(Math.min(maxAge, Math.max(0, carCohortAge))).toFixed(1)}" cy="${calcPriceY(depreciationCurve.carPrice).toFixed(1)}" r="3" fill="#81C784" stroke="rgba(20,20,28,0.95)" stroke-width="1.2">
          <title>이 차량 ${depreciationCurve.carPrice.toLocaleString()}만원 · 출고 ${depreciationCurve.carAge.toFixed(1)}년</title>
        </circle>`
      : '';

    const middleCount = Math.round(maxCount / 2);
    const middlePrice = Math.round((minPrice + maxPrice) / 2);
    return `<div class="encar-year-market-chart">
      <div class="encar-tooltip-divider"></div>
      <div class="encar-year-chart-header">
        <div class="encar-year-chart-title">연식별 가격·매물 분포</div>
        <div class="encar-year-chart-legend">
          <span><span class="encar-year-count-swatch"></span>매물수</span>
          <span><span class="encar-year-price-swatch"></span>판매중</span>
          ${curveSvg ? '<span><span class="encar-year-curve-swatch"></span>추정곡선</span>' : ''}
        </div>
      </div>
      <svg class="encar-year-chart-svg" viewBox="0 0 ${chartWidth} 87">
        <line x1="${plotLeft}" y1="${plotTop}" x2="${plotRight}" y2="${plotTop}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
        <line x1="${plotLeft}" y1="${((plotTop + baselineY) / 2).toFixed(1)}" x2="${plotRight}" y2="${((plotTop + baselineY) / 2).toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="2 3"/>
        <line x1="${plotLeft}" y1="${baselineY}" x2="${plotRight}" y2="${baselineY}" stroke="rgba(255,255,255,0.28)" stroke-width="1.2"/>

        <text x="2" y="${plotTop + 2}" fill="rgba(100,181,246,0.8)" font-size="6.8">${maxCount}</text>
        <text x="2" y="${((plotTop + baselineY) / 2 + 2).toFixed(1)}" fill="rgba(100,181,246,0.55)" font-size="6.8">${middleCount}</text>
        <text x="2" y="${baselineY + 2}" fill="rgba(100,181,246,0.45)" font-size="6.8">0</text>

        <text x="${priceAxisX}" y="${plotTop + 2}" fill="rgba(255,213,79,0.85)" text-anchor="end" font-size="6.8">${maxPrice.toLocaleString()}</text>
        <text x="${priceAxisX}" y="${((plotTop + baselineY) / 2 + 2).toFixed(1)}" fill="rgba(255,213,79,0.6)" text-anchor="end" font-size="6.8">${middlePrice.toLocaleString()}</text>
        <text x="${priceAxisX}" y="${baselineY + 2}" fill="rgba(255,213,79,0.45)" text-anchor="end" font-size="6.8">${minPrice.toLocaleString()}</text>

        ${barsSvg}
        ${currentAgeMarker}
        <path d="${priceLinePath}" fill="none" stroke="#FFD54F" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${curveSvg}
        ${pricePointsSvg}
        ${carPointSvg}
        ${newCarPriceSvg}
        ${priceLabelsSvg}
        ${ageLabelsSvg}
        <text x="${chartCenter}" y="83" fill="rgba(255,255,255,0.45)" text-anchor="middle" font-size="6.3">출고 후 경과 연수 · 등록연식</text>
      </svg>
    </div>`;
  }

  function createScoreBadge(scoreResult, cardData, weights, fullData = {}) {
    const w = weights || EncarScoring.DEFAULT_WEIGHTS;
    const carId = fullData.carId || cardData.carId || null;
    const badge = document.createElement('div');
    badge.className = 'encar-score-badge';
    badge.style.background = EncarScoring.getGradeGradient(scoreResult.grade);

    badge.innerHTML = `
      <div class="encar-score-grade">${scoreResult.grade}</div>
      <div class="encar-score-number">${scoreResult.total}점</div>
    `;

    // ── 툴팁 상세 정보 계산 ──
    const { actualCarId = null,
            originPrice = 0, price = 0, mileage = 0, year = 0,
            insuranceCount = 0, isInsurancePrivate = false,
            myDamageCount = 0, myDamageAmount = 0,
            otherDamageCount = 0, otherDamageAmount = 0,
            hasUnavailablePeriod = false, unavailablePeriods = [],
            ownerChangeCount = 0,
            isInspectionPrivate = false,
            hasInspection = false, hasReplacement = false, hasWelding = false, hasCorrosion = false,
            hasDiagnosis = false, diagnosisTier = null,
            hasRentalHistory = false,
            firstAdvertisedDateTime = null,
            dealerJoinedDatetime = null, dealerTotalSales = 0,
            dealerAvgScore = null, dealerName = '', dealerFirmName = '' } = fullData;
    const registedAgo = formatRelativeTime(firstAdvertisedDateTime);
    const soldOutLookupId = actualCarId || carId;
    const canAnalyzeSoldOut = Boolean(soldOutLookupId) && isDetailPage();

    // 사고/보험이력 건수 텍스트
    const accidentLines = [];
    if (isInsurancePrivate) {
      accidentLines.push('조회불가 · 비공개');
    } else {
      if (insuranceCount === 0) accidentLines.push('무사고');
      if (myDamageCount > 0) accidentLines.push(`내차피해 ${myDamageCount}회 · ${Math.round(myDamageAmount / 10000).toLocaleString()}만원`);
      if (otherDamageCount > 0) accidentLines.push(`타차가해 ${otherDamageCount}회 · ${Math.round(otherDamageAmount / 10000).toLocaleString()}만원`);
    }
    if (hasUnavailablePeriod) {
      accidentLines.push(`⚠️ 정보제공 불가기간: ${unavailablePeriods.join(', ')}`);
    }
    const accidentText = accidentLines.join('\n');

    // 가격점수 기준: 현재 차량과 같은 출고연도의 평균가격
    const yearlyPricePoint = EncarScoring.getYearlyPricePoint(fullData);
    const yearlyPriceDeviation = yearlyPricePoint && price > 0
      ? price / yearlyPricePoint.avgPrice - 1
      : null;
    const yearlyPriceAbsPct = yearlyPriceDeviation === null
      ? null
      : Math.round(Math.abs(yearlyPriceDeviation) * 100);
    const yearlyPriceDiffText = yearlyPriceDeviation === null
      ? '동일 연식 평균 데이터 부족'
      : Math.abs(yearlyPriceDeviation) < 0.02
        ? '동일 연식 평균 수준'
        : yearlyPriceDeviation < 0
          ? `동일 연식 평균보다 ${yearlyPriceAbsPct}% 저렴`
          : `동일 연식 평균보다 ${yearlyPriceAbsPct}% 비쌈`;
    const priceDetail = yearlyPricePoint
      ? `연식평균 ${yearlyPricePoint.avgPrice.toLocaleString()}만원 · ${yearlyPriceDiffText.replace('동일 연식 ', '')}`
      : price > 0 ? yearlyPriceDiffText : '';

    // 동급매물 시세 정보 (SVG 바)
    const market = fullData.marketPriceData;
    let marketDetail = '';
    if (market && market.median > 0 && price > 0) {
      const pinColor = yearlyPriceDeviation === null ? '#9E9E9E'
                     : yearlyPriceDeviation <= -0.05 ? '#4CAF50'
                     : yearlyPriceDeviation >= 0.15  ? '#F44336'
                     : yearlyPriceDeviation >= 0.05  ? '#FF9800'
                     : '#FFD700';
      const diffText = yearlyPriceDiffText;

      const rawItems = Array.isArray(market.items) && market.items.length > 0
        ? market.items
        : (Array.isArray(market.prices) ? market.prices.map(p => ({ price: p, grade: '일반' })) : []);

      // 차량 판매가(price) 기준 약 5% 단위로 가격 구간(binStep) 설정
      const carRefPrice = price > 0 ? price : (market.median || 2000);
      const rawStep = carRefPrice * 0.05;
      const binStep = rawStep < 30 ? 20 : (rawStep < 75 ? 50 : Math.max(50, Math.round(rawStep / 50) * 50));

      // 매물 가격 목록 (현재 차량 가격 포함)
      const allPrices = rawItems.map(it => it.price).filter(p => typeof p === 'number' && p > 0);
      if (price > 0) allPrices.push(price);

      const minP = Math.min(...allPrices);
      const maxP = Math.max(...allPrices);

      // 시작/종료 가격을 binStep 배수로 깔끔하게 정렬 (예: 1900~2000, 2000~2100...)
      let startPrice = Math.floor(minP / binStep) * binStep;
      let endPrice = Math.ceil(maxP / binStep) * binStep;
      if (endPrice <= startPrice) endPrice = startPrice + binStep;

      let numBins = Math.round((endPrice - startPrice) / binStep);
      // 시각적 균형을 위해 최소 6개 구간 확보
      while (numBins < 6) {
        startPrice = Math.max(0, startPrice - binStep);
        endPrice += binStep;
        numBins = Math.round((endPrice - startPrice) / binStep);
      }
      // 구간이 너무 많을 경우(이상치 등) 최대 16구간으로 제한
      if (numBins > 16) {
        const sortedP = [...allPrices].sort((a, b) => a - b);
        const p05 = sortedP[Math.floor(sortedP.length * 0.05)];
        const p95 = sortedP[Math.floor(sortedP.length * 0.95)];
        startPrice = Math.floor(Math.min(price, p05) / binStep) * binStep;
        endPrice = Math.ceil(Math.max(price, p95) / binStep) * binStep;
        if (endPrice <= startPrice) endPrice = startPrice + binStep * 6;
        numBins = Math.round((endPrice - startPrice) / binStep);
      }

      // 이상치 때문에 표시 범위를 줄인 경우 범위 밖 매물을 양 끝 bin에 억지로 넣지 않는다.
      const chartItems = rawItems.filter(item =>
        typeof item.price === 'number' && item.price >= startPrice && item.price <= endPrice
      );

      // 가격을 X 좌표(10 ~ 190)로 변환하는 함수
      const calcPriceX = (p) => {
        const pct = (p - startPrice) / (endPrice - startPrice);
        const clampedPct = Math.max(0, Math.min(1, pct));
        return 10 + clampedPct * 180;
      };

      const priceXNum = calcPriceX(price);
      const priceX    = priceXNum.toFixed(1);

      // 등급별 색상 팔레트
      const GRADE_COLORS = [
        '#64B5F6', // 하늘/파랑
        '#4DB6AC', // 청록/민트
        '#81C784', // 연초록
        '#FFD54F', // 골드/노랑
        '#FFB74D', // 주황
        '#BA68C8', // 보라
        '#F06292'  // 핑크
      ];

      // 고유 등급 목록
      const uniqueGrades = [...new Set(chartItems.map(it => it.grade || '일반').filter(Boolean))];
      const gradeColorMap = {};
      uniqueGrades.forEach((g, idx) => {
        gradeColorMap[g] = GRADE_COLORS[idx % GRADE_COLORS.length];
      });

      // --- 2D 히스토그램 & 정규분포 곡선 데이터 계산 ---
      const binWidth = 180 / numBins;
      const barWidth = Math.max(4, binWidth - 2.5);
      const baselineY = 47;
      const maxBarHeight = 29; // 바 최대 높이

      const bins = Array.from({ length: numBins }, (_, i) => {
        const lo = startPrice + i * binStep;
        const hi = lo + binStep;
        return {
          index: i,
          rangeLabel: `${lo}~${hi}`,
          startX: 10 + i * binWidth,
          centerX: 10 + (i + 0.5) * binWidth,
          items: []
        };
      });

      chartItems.forEach(it => {
        const binIdx = Math.min(numBins - 1, Math.max(0, Math.floor((it.price - startPrice) / binStep)));
        bins[binIdx].items.push(it);
      });

      // 상세 조회가 끝난 매물의 점수를 가격 구간별로 평균낸다.
      bins.forEach(bin => {
        const scores = bin.items
          .map(item => item.score)
          .filter(score => Number.isFinite(score));
        bin.scoredCount = scores.length;
        bin.avgScore = scores.length > 0
          ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
          : null;
      });

      const maxBinCount = Math.max(1, ...bins.map(b => b.items.length));

      // 히스토그램 바(Stacked Rects) 생성 (등급별 스택)
      const histogramBarsSvg = bins.map(b => {
        if (b.items.length === 0) return '';
        const barX = (b.centerX - barWidth / 2).toFixed(1);
        const sortedItems = [...b.items].sort((a, b) => {
          const gA = a.grade || '';
          const gB = b.grade || '';
          return gA.localeCompare(gB);
        });

        let currentY = baselineY;
        return sortedItems.map((it, idx) => {
          const segHeight = (1 / maxBinCount) * maxBarHeight;
          currentY -= segHeight;
          const gKey = it.grade || '일반';
          const col = gradeColorMap[gKey] || 'rgba(255,255,255,0.45)';
          const isTop = idx === sortedItems.length - 1;
          const rxAttr = isTop ? 'rx="2" ry="2"' : '';
          const avgText = b.avgScore === null ? '' : ` · 평균 ${b.avgScore}점`;
          return `<rect x="${barX}" y="${currentY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${segHeight.toFixed(1)}" fill="${col}" opacity="0.85" ${rxAttr}><title>${b.rangeLabel}만원 (${b.items.length}대${avgText})</title></rect>`;
        }).join('');
      }).join('');

      // 정규분포 느낌의 부드러운 곡선(Bell curve) 생성
      const curvePoints = [
        { x: 10, y: baselineY },
        ...bins.map(b => {
          const h = (b.items.length / maxBinCount) * maxBarHeight;
          return { x: b.centerX, y: baselineY - h };
        }),
        { x: 190, y: baselineY }
      ];

      const getSplinePath = (pts) => {
        if (pts.length < 2) return '';
        let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i];
          const p1 = pts[i + 1];
          const mx = (p0.x + p1.x) / 2;
          d += ` C ${mx.toFixed(1)} ${p0.y.toFixed(1)}, ${mx.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
        }
        return d;
      };

      const linePath = getSplinePath(curvePoints);
      const areaPath = `${linePath} L 190 ${baselineY} L 10 ${baselineY} Z`;

      // 구간 평균점수(0~100)는 히스토그램 위에 선/점/숫자로 표시한다.
      // 빈 가격 구간을 가로질러 선이 연결되지 않도록 인접한 점끼리만 잇는다.
      const scoreTopY = 10;
      const scoreBottomY = baselineY - 2;
      const calcScoreY = score => scoreBottomY - (score / 100) * (scoreBottomY - scoreTopY);
      let previousScorePoint = null;
      const scoreLineParts = [];
      const scorePointParts = [];

      bins.forEach(bin => {
        if (bin.avgScore === null) {
          previousScorePoint = null;
          return;
        }

        const point = { x: bin.centerX, y: calcScoreY(bin.avgScore) };
        if (previousScorePoint) {
          scoreLineParts.push(
            `<line x1="${previousScorePoint.x.toFixed(1)}" y1="${previousScorePoint.y.toFixed(1)}" x2="${point.x.toFixed(1)}" y2="${point.y.toFixed(1)}" stroke="rgba(255,255,255,0.9)" stroke-width="1.2" stroke-linecap="round"/>`
          );
        }

        const scoreGrade = EncarScoring.getGrade(bin.avgScore);
        const scoreColor = EncarScoring.getGradeColor(scoreGrade);
        const labelY = Math.max(7, point.y - 3.5);
        scorePointParts.push(`
          <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.6" fill="${scoreColor}" stroke="#fff" stroke-width="0.8">
            <title>${bin.rangeLabel}만원 평균 ${bin.avgScore}점 (${bin.scoredCount}대 분석)</title>
          </circle>
          <text x="${point.x.toFixed(1)}" y="${labelY.toFixed(1)}" fill="${scoreColor}" stroke="rgba(20,20,28,0.9)" stroke-width="1.4" paint-order="stroke" text-anchor="middle" font-size="6.5" font-weight="700">${bin.avgScore}</text>`);
        previousScorePoint = point;
      });

      const averageScoreSvg = `${scoreLineParts.join('')}${scorePointParts.join('')}`;
      // 신차가 pin (구간 범위 내에 있을 때만 표시)
      const hasOriginInScale = originPrice > 0 && originPrice >= startPrice && originPrice <= endPrice;
      const originPinSvg = hasOriginInScale ? `
          <line x1="${calcPriceX(originPrice).toFixed(1)}" y1="12" x2="${calcPriceX(originPrice).toFixed(1)}" y2="${baselineY}" stroke="rgba(200,200,200,0.5)" stroke-width="1.2" stroke-dasharray="2 2"/>
          <circle cx="${calcPriceX(originPrice).toFixed(1)}" cy="${baselineY}" r="2.5" fill="rgba(180,180,180,0.6)"/>` : '';

      // 중앙값 (Median) 점선
      const medianXNum = calcPriceX(market.median);
      const medianX    = medianXNum.toFixed(1);
      const medianIndicatorSvg = `
          <line x1="${medianX}" y1="12" x2="${medianX}" y2="${baselineY}" stroke="rgba(255,255,255,0.4)" stroke-width="1.2" stroke-dasharray="2 2"/>
          <circle cx="${medianX}" cy="${baselineY}" r="2" fill="rgba(255,255,255,0.7)"/>`;

      // 현재 매물 가격 위치 인디케이터
      const currentIndicatorSvg = `
          <line x1="${priceX}" y1="8" x2="${priceX}" y2="${baselineY}" stroke="${pinColor}" stroke-width="2" stroke-linecap="round"/>
          <circle cx="${priceX}" cy="6" r="4.5" fill="${pinColor}"/>
          <circle cx="${priceX}" cy="6" r="2" fill="#fff" opacity="0.7"/>
          <circle cx="${priceX}" cy="${baselineY}" r="3" fill="${pinColor}"/>`;

      marketDetail = `<div class="encar-price-meter">
        <div class="encar-price-axis-title">
          <span>막대: 매물수</span>
          <span class="encar-price-score-legend"><span class="encar-price-score-dot"></span>평균점수(0~100)</span>
        </div>
        <svg class="encar-price-svg" viewBox="0 0 200 55">
          <defs>
            <linearGradient id="bellAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="rgba(144, 202, 249, 0.4)" />
              <stop offset="100%" stop-color="rgba(144, 202, 249, 0.03)" />
            </linearGradient>
          </defs>
          <line x1="10" y1="18" x2="190" y2="18" stroke="rgba(255,255,255,0.05)" stroke-width="1" stroke-dasharray="2 4"/>
          <line x1="10" y1="32" x2="190" y2="32" stroke="rgba(255,255,255,0.05)" stroke-width="1" stroke-dasharray="2 4"/>

          <!-- 정규분포 부드러운 배경 영역 & 곡선 -->
          <path d="${areaPath}" fill="url(#bellAreaGrad)" />
          <path d="${linePath}" fill="none" stroke="rgba(144, 202, 249, 0.55)" stroke-width="1.5" stroke-linecap="round"/>

          <!-- 히스토그램 바 (등급별 스택) -->
          ${histogramBarsSvg}

          <!-- 가격 구간별 평균점수 -->
          ${averageScoreSvg}

          <!-- X축 기준선 -->
          <line x1="10" y1="${baselineY}" x2="190" y2="${baselineY}" stroke="rgba(255,255,255,0.25)" stroke-width="1.5" stroke-linecap="round"/>

          <!-- 신차가 및 중앙값 가이드라인 -->
          ${originPinSvg}
          ${medianIndicatorSvg}

          <!-- 현재 매물 가격 위치 핀 -->
          ${currentIndicatorSvg}
        </svg>
        <div class="encar-price-meter-labels">
          <span>${startPrice.toLocaleString()}만</span>
          <span>중앙값 ${market.median.toLocaleString()}만원 · ${binStep}만 단위</span>
          <span>${endPrice.toLocaleString()}만</span>
        </div>
        <div class="encar-price-diff-text" style="color:${pinColor}">${diffText}</div>
      </div>`;
    }
    const yearlyMarketDetail = createYearlyMarketChart(fullData.yearlyMarketData, year, originPrice);
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

    // 감가 현황: 누적 감가는 바로 표시하고, 감가 속도는 모델 그룹 감가곡선을 불러온 뒤 채운다.
    const carAgeYears = year > 0
      ? Math.max(0, (nowYear - (2000 + year)) + (nowMonth - (registMonth > 0 ? registMonth : 6.5)) / 12)
      : null;
    const cumulativeDepreciation = originPrice > 0 && price > 0 ? 1 - price / originPrice : null;
    const depreciationTotalText = cumulativeDepreciation === null
      ? '신차가 정보 없음'
      : `신차가 ${originPrice.toLocaleString()}만원 → ${price.toLocaleString()}만원 · ${cumulativeDepreciation >= 0
          ? `누적 ${Math.round(cumulativeDepreciation * 100)}% 감가`
          : `신차가보다 ${Math.round(-cumulativeDepreciation * 100)}% 높음`}`;
    const canShowDepreciation = carAgeYears !== null && price > 0;

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
    const apiModelName = fullData.modelName || '';

    const tooltip = document.createElement('div');
    tooltip.className = 'encar-score-tooltip';
    tooltip.innerHTML = `
      <div class="encar-tooltip-heading">
        <div class="encar-tooltip-title">${apiModelName || cardData.modelName}</div>
        ${registedAgo ? `<div class="encar-tooltip-registed">${registedAgo} 등록</div>` : ''}
      </div>
      <div class="encar-tooltip-total">종합점수: <strong>${scoreResult.total}점</strong> (${scoreResult.grade}등급)</div>
      ${scoreResult.penalty ? `<div style="color:#ff5252; font-size:12px; margin-top:4px;">⚠️ 미공개 항목 페널티 (-40점)</div>` : ''}
      <div class="encar-tooltip-divider"></div>
      <div class="encar-tooltip-row">
        <span>🚗 사고/보험이력 (${insuranceCount}건)</span>
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
      ${yearlyMarketDetail}
      ${canShowDepreciation ? `<section class="encar-depreciation">
        <div class="encar-tooltip-row">
          <span>📉 감가 현황</span>
          <span class="encar-depreciation-level" data-encar-depreciation-level></span>
        </div>
        <div class="encar-depreciation-forecast encar-loading" data-encar-depreciation-forecast>감가곡선 계산 중…</div>
        <div class="encar-tooltip-detail">출고 ${carAgeYears.toFixed(1)}년 · ${depreciationTotalText}</div>
      </section>` : ''}
      ${canAnalyzeSoldOut ? '<section class="encar-trade-activity"><div class="encar-tooltip-row"><span>📊 거래 현황</span><span>최근 30일 · 전체 연식</span></div><div class="encar-loading" data-encar-activity-main>거래 현황 조회 중…</div><div data-encar-activity-note></div><div data-encar-activity-scope></div></section>' : ''}
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
      <section class="encar-tooltip-owner-section">
      <div class="encar-tooltip-row">
        <span>👤 소유주/판매자 이력</span>
        <span>${Math.round(scoreResult.breakdown.ownerChanges)}/${w.ownerChanges}</span>
      </div>
      <div class="encar-tooltip-detail">소유자 변경: ${ownerChangeCount}회</div>
      ${createOwnerTimeline(fullData)}
      </section>
      ${dealerAvgScore ? `
      <div class="encar-tooltip-divider"></div>
      <div class="encar-tooltip-row">
        <span>🏪 ${dealerFullName} 평균</span>
        <span style="color:${EncarScoring.getGradeColor(EncarScoring.getGrade(dealerAvgScore.avg))};font-weight:600">${dealerAvgScore.avg}점</span>
      </div>
      <div class="encar-tooltip-detail">최근 ${dealerAvgScore.count}개 매물 기준</div>` : ''}
      ${dealerText ? `<div class="encar-tooltip-detail">${dealerText}</div>` : ''}
    `;

    const tooltipMain = document.createElement('div');
    tooltipMain.className = 'encar-tooltip-main';
    tooltipMain.append(...tooltip.childNodes);
    tooltip.appendChild(tooltipMain);
    const ownerSection = tooltipMain.querySelector('.encar-tooltip-owner-section');
    const ownerPlaceholder = document.createComment('owner-section-position');
    ownerSection.before(ownerPlaceholder);

    // 클립보드 복사 텍스트 생성
    const { manufacturerName = '', gradeName = '',
            rankCounts = null, diagFrameReplacement = false, diagPanelReplacement = false } = fullData;
    const brandModel = [manufacturerName, apiModelName || cardData.modelName, gradeName].filter(Boolean).join(' ');

    const yearStr = (year > 0) ? `20${String(year).padStart(2, '0')}년${registMonth > 0 ? ` ${registMonth}월` : ''}` : '정보없음';
    const mileageStr = mileage > 0 ? `${mileage.toLocaleString()}km` : '정보없음';

    let priceStr = price > 0 ? `${price.toLocaleString()}만원` : '정보없음';
    if (originPrice > 0) priceStr += ` (신차가 ${originPrice.toLocaleString()}만원)`;

    // 가격점수에 사용한 동일 연식 평균가격 텍스트
    let marketStr = '';
    if (yearlyPricePoint && price > 0) {
      marketStr = `${yearlyPriceDiffText} (연식평균 ${yearlyPricePoint.avgPrice.toLocaleString()}만원)`;
    } else if (price > 0) {
      marketStr = yearlyPriceDiffText;
    }

    // 보험이력 (비공개·내차피해·타차가해·제공불가기간 포함)
    let insuranceStr;
    if (isInsurancePrivate) {
      insuranceStr = '비공개';
    } else {
      if(insuranceCount === 0) insuranceStr = '무사고';
      if (myDamageCount > 0) insuranceStr += ` (내차피해 ${myDamageCount}회 ${Math.round(myDamageAmount / 10000).toLocaleString()}만원)`;
      if (otherDamageCount > 0) insuranceStr += ` (타차가해 ${otherDamageCount}회 ${Math.round(otherDamageAmount / 10000).toLocaleString()}만원)`;
      if (hasUnavailablePeriod) insuranceStr += ` / 제공불가기간: ${unavailablePeriods.join(', ')}`;
    }

    const inspParts = [];
    if (isInspectionPrivate) {
      inspParts.push('비공개');
    } else if (!hasInspection) {
      inspParts.push('미등록');
    } else {
      if (hasReplacement) inspParts.push('교환');
      if (hasWelding) inspParts.push('판금');
      if (hasCorrosion) inspParts.push('부식');
      if (inspParts.length === 0) inspParts.push('양호');
      // 프레임/외판 교환 상세
      const frameParts = [];
      if (rankCounts) {
        if (rankCounts.A.X > 0 || rankCounts.B.X > 0) frameParts.push(`골격교환 ${rankCounts.A.X + rankCounts.B.X}개소`);
        if (rankCounts.ONE.X > 0 || rankCounts.TWO.X > 0) frameParts.push(`외판교환 ${rankCounts.ONE.X + rankCounts.TWO.X}개소`);
      }
      if (frameParts.length > 0) inspParts.push(frameParts.join(', '));
    }
    if (hasDiagnosis) {
      const diagStr = diagnosisTier === 'PLUSPLUS' ? '엔카진단++' : diagnosisTier === 'PLUS' ? '엔카진단+' : '엔카진단';
      const diagDetails = [];
      if (diagFrameReplacement) diagDetails.push('프레임교환');
      if (diagPanelReplacement) diagDetails.push('외판교환');
      inspParts.push(diagDetails.length > 0 ? `${diagStr}(${diagDetails.join(',')})` : diagStr);
    }
    const inspStr = inspParts.join(' / ');

    const rentalStr = hasRentalHistory ? '있음' : '없음';
    const ownerStr = `${ownerChangeCount}회`;

    const clipboardLines = [`모델: ${brandModel}`];
    if (registedAgo) clipboardLines.push(`등록: ${registedAgo}`);
    clipboardLines.push(
      `연식: ${yearStr}`,
      `주행거리: ${mileageStr}${annualKm ? ` (${annualKm})` : ''}`,
      `가격: ${priceStr}`,
    );
    if (marketStr) clipboardLines.push(`시세: ${marketStr}`);
    clipboardLines.push(
      `보험이력: ${insuranceStr}`,
      `성능점검: ${inspStr}`,
      `렌트이력: ${rentalStr}`,
      `소유주변경: ${ownerStr}`,
    );
    if (dealerAvgScore) {
      clipboardLines.push(`${dealerFullName} 평균점수: ${dealerAvgScore.avg}점 (최근 ${dealerAvgScore.count}개 매물)`);
    }
    if (dealerText) clipboardLines.push(dealerText);
    let clipboardText = clipboardLines.join('\n');
    // 툴팁을 연 뒤 늦게 도착하는 거래 현황·감가 정보는 여기에 모아 복사·AI 분석 텍스트 끝에 붙인다.
    const clipboardExtras = {};
    const refreshClipboardText = () => {
      clipboardText = [clipboardLines.join('\n'), clipboardExtras.activity, clipboardExtras.depreciation]
        .filter(Boolean)
        .join('\n');
    };
    if (canShowDepreciation && cumulativeDepreciation !== null) {
      clipboardExtras.depreciation = `감가: ${depreciationTotalText}`;
      refreshClipboardText();
    }

    // 배지 클릭 시 액션 메뉴 표시
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // 이미 열린 메뉴가 있으면 닫기
      const existing = document.querySelector('.encar-action-menu');
      if (existing) { existing.remove(); return; }

      const menu = document.createElement('div');
      menu.className = 'encar-action-menu';
      menu.innerHTML = `
        <button class="encar-action-btn" data-action="copy">📋 클립보드 복사</button>
        <button class="encar-action-btn" data-action="ai">🤖 AI 분석</button>
      `;
      document.body.appendChild(menu);

      // 메뉴 위치 (배지 위쪽, 오른쪽 정렬)
      const rect = badge.getBoundingClientRect();
      const mH = menu.offsetHeight;
      const mW = menu.offsetWidth;
      let top = rect.top - mH - 8;
      let left = rect.right - mW;
      if (top < 10) top = rect.bottom + 8;
      if (left < 10) left = 10;
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;

      menu.querySelector('[data-action="copy"]').addEventListener('click', (e2) => {
        e2.stopPropagation();
        menu.remove();
        navigator.clipboard.writeText(clipboardText).then(() => {
          const origHTML = badge.innerHTML;
          badge.innerHTML = `<div class="encar-score-number" style="font-size:10px;">복사됨!</div>`;
          setTimeout(() => { badge.innerHTML = origHTML; }, 1000);
        });
      });

      menu.querySelector('[data-action="ai"]').addEventListener('click', (e2) => {
        e2.stopPropagation();
        menu.remove();
        showAIModal(carId, clipboardText);
      });

      const closeMenu = (e2) => {
        if (!menu.contains(e2.target)) {
          menu.remove();
          document.removeEventListener('click', closeMenu);
        }
      };
      setTimeout(() => document.addEventListener('click', closeMenu), 0);
    });
    badge.style.cursor = 'pointer';

    // AI 분석 캐시 확인 → 배지에 dot 표시
    if (carId) {
      badge.dataset.carId = carId;
      if (localStorage.getItem(`encar_ai_${carId}`)) {
        const dot = document.createElement('div');
        dot.className = 'encar-ai-dot';
        badge.appendChild(dot);
      }
    }

    const positionTooltip = () => {
      if (!tooltip.isConnected) return;
      // 먼저 기본 한 열의 실제 높이를 측정하고, 넘칠 때만 이력을 오른쪽으로 이동한다.
      tooltip.classList.remove('encar-tooltip-wide');
      ownerPlaceholder.after(ownerSection);
      tooltip.style.maxHeight = 'none';
      const availableHeight = Math.max(1, window.innerHeight - 24);
      if (tooltip.offsetHeight > availableHeight && window.innerWidth >= 764) {
        tooltip.appendChild(ownerSection);
        tooltip.classList.add('encar-tooltip-wide');
      }
      tooltip.style.maxHeight = `${availableHeight}px`;
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
      left = Math.max(12, Math.min(left, window.innerWidth - tooltipWidth - 12));
      top = Math.max(12, Math.min(top, window.innerHeight - tooltipHeight - 12));

      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
      tooltip.style.right = 'auto';
      tooltip.style.bottom = 'auto';
      tooltip.style.visibility = 'visible';
    };

    let depreciationLoadStarted = false;
    const loadDepreciation = async () => {
      if (depreciationLoadStarted || !canShowDepreciation) return;
      depreciationLoadStarted = true;
      const levelEl = tooltip.querySelector('[data-encar-depreciation-level]');
      const forecastEl = tooltip.querySelector('[data-encar-depreciation-forecast]');
      if (!levelEl || !forecastEl) return;
      // 추정할 수 없으면 예상가 자리에 사유를 표시한다.
      const showUnavailable = (label, detail) => {
        levelEl.textContent = label;
        levelEl.className = 'encar-depreciation-level encar-depreciation-level--none';
        forecastEl.className = 'encar-depreciation-forecast';
        forecastEl.textContent = detail;
      };
      if (!fullData.modelGroupName) {
        showUnavailable('추정 불가', '모델 정보 없음');
        return;
      }
      // 조회·계산이 끝날 때까지 예상가 자리에 스피너를 보여준다.
      levelEl.textContent = '';
      forecastEl.className = 'encar-depreciation-forecast encar-loading';
      forecastEl.textContent = '감가곡선 계산 중…';
      const percent = value => `${(value * 100).toFixed(1)}%`;

      try {
        const { curve, reason } = await EncarDepreciation.fetchCurve(fullData.modelGroupName);
        if (!curve) {
          showUnavailable('추정 불가', reason);
          return;
        }
        const result = EncarDepreciation.estimate(curve, { age: carAgeYears, price, originPrice });
        // 1년 후 예상가 = 현재가 - 예상 하락액. 표시값끼리 더하면 현재가가 되도록 하락액을 먼저 반올림한다.
        const yearLoss = Math.round(result.yearLoss);
        forecastEl.className = 'encar-depreciation-forecast';
        forecastEl.textContent = `1년 후 예상가 ${(price - yearLoss).toLocaleString()}만원 (-${yearLoss.toLocaleString()}만원${result.originRate !== null ? `, 신차가 대비 ${percent(result.originRate)}` : ''})`;
        if (result.level) {
          levelEl.textContent = result.level.label;
          levelEl.className = `encar-depreciation-level encar-depreciation-level--${result.level.key}`;
        } else {
          // 단계는 신차가 대비로 판단하므로 신차가가 없으면 판정하지 않는다.
          levelEl.textContent = '신차가 정보 없음';
          levelEl.className = 'encar-depreciation-level encar-depreciation-level--none';
        }
        // 표본이 적은 모델 그룹은 부트스트랩 90% 범위를 함께 표시한다. 신차가가 있으면 신차가 대비로 보여준다.
        const range = result.originRateRange || result.rateRange;
        const rangeText = range
          ? `90% 범위 ${result.originRateRange ? '신차가 대비 ' : ''}${percent(range[0])}~${percent(range[1])}`
          : '';
        // 현재가 대비 감가율·회귀 근거는 화면에서 빼고 ⓘ 설명과 복사 텍스트에만 둔다.
        const rateText = [
          `현재가 대비 ${percent(result.totalRate)} (연식 ${percent(result.ageRate)} + 주행 ${percent(result.mileageRate)})`,
          ...(rangeText ? [rangeText] : [])
        ].join(' · ');
        const basisText = [
          `${fullData.modelGroupName} 매물 ${curve.sampleCount.toLocaleString()}대 회귀`,
          `1만km당 -${percent(result.mileageRatePer10k)}`,
          `모델 평균 연 ${Math.round(result.kmPerYear * 10000).toLocaleString()}km 주행 가정`,
          ...(result.extrapolated ? ['표본 연식 범위 밖 추정'] : [])
        ].join(' · ');
        forecastEl.textContent += ' ⓘ';
        forecastEl.title = `${rateText}\n${basisText}\n\n` + '1년 후 예상가 = 현재가 - 1년간 예상 하락액. 신차가 대비 = 하락액 ÷ 신차가(옵션 포함), 현재가 대비 = 연식 감가(경과연수에 따른 하락) + 주행 감가(모델 평균만큼 1년 더 주행할 때의 하락).' +
          ' 단계(신차가 대비): 6.5% 이상 가파른 감가 · 4~6.5% 평균적 감가 · 2.5~4% 완만한 감가 · 2.5% 미만 감가 둔화.' +
          ' 같은 모델 그룹(여러 세대·트림)의 최근 매물을 회귀해 추정했으며, 지금까지의 주행 이력은 현재 가격에 이미 반영돼 있습니다.' +
          (range ? ' 괄호 안은 표본이 500대 미만이라 매물을 다시 뽑아 50번 추정한 90% 범위입니다.' : '') +
          ' 매물 가격 기준이며 실제 거래가나 향후 시세 변동과 다를 수 있습니다.';

        // 연식별 차트에 추정 곡선과 현재 차량 위치를 겹쳐 다시 그린다.
        // 정수 경과연수 코호트의 평균 경과연수는 연중 고르게 등록됐다고 보고 보정한다.
        const ageShift = (nowMonth - 6.5) / 12;
        const priceAt = EncarDepreciation.fitLevelToPoints(curve, fullData.yearlyMarketData?.points || [], ageShift);
        const currentChart = tooltip.querySelector('.encar-year-market-chart');
        if (priceAt && currentChart) {
          const holder = document.createElement('div');
          holder.innerHTML = createYearlyMarketChart(fullData.yearlyMarketData, year, originPrice, {
            priceAt,
            ageShift,
            carAge: carAgeYears,
            carPrice: price
          }).trim();
          if (holder.firstElementChild) currentChart.replaceWith(holder.firstElementChild);
        }

        clipboardExtras.depreciation = [
          `감가: ${depreciationTotalText}`,
          `현재 감가: ${levelEl.textContent} · ${forecastEl.textContent.replace(/ ⓘ$/, '')} · ${rateText}`,
          `감가 추정 근거: ${basisText} (매물 가격 기준 추정)`
        ].join('\n');
        refreshClipboardText();
      } catch (error) {
        // 실패하면 다음 툴팁 열기에서 다시 시도한다.
        depreciationLoadStarted = false;
        showUnavailable('조회 실패', '감가곡선 조회 실패 · 툴팁을 다시 열면 재시도합니다');
        console.warn('[EncarScore] 감가곡선 조회 실패:', error);
      } finally {
        requestAnimationFrame(positionTooltip);
      }
    };

    let activityLoading = false;
    let activityLoadedAt = 0;
    const loadTradeActivity = async () => {
      if (!canAnalyzeSoldOut || activityLoading || Date.now() - activityLoadedAt < 30 * 60 * 1000) return;
      activityLoading = true;
      const main = tooltip.querySelector('[data-encar-activity-main]');
      const note = tooltip.querySelector('[data-encar-activity-note]');
      const scope = tooltip.querySelector('[data-encar-activity-scope]');
      main.className = 'encar-loading';
      main.textContent = '거래 현황 조회 중…';
      note.textContent = '';
      scope.textContent = '';
      clipboardExtras.activity = '거래 현황: 조회 중';
      refreshClipboardText();
      try {
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({type: 'FETCH_ENCAR_TRADE_ACTIVITY', carId: soldOutLookupId}, result => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(result);
          });
        });
        if (!response?.ok) throw new Error(response?.error || '조회 실패');
        const d = response.data;
        main.className = '';
        const activeText = `현재 판매 중 ${d.active.toLocaleString()}대${d.activeComplete ? '' : ' 이상'}`;
        const soldText = `최근 30일 판매완료 ${d.sold.toLocaleString()}건${d.soldComplete ? '' : ' 이상'}`;
        const total = d.active + d.sold;
        const complete = d.activeComplete && d.soldComplete;
        const activePercent = total > 0 ? d.active / total * 100 : 0;
        const soldPercent = total > 0 ? d.sold / total * 100 : 0;
        // 부분 집계는 실제 비율을 알 수 없으므로 비율 막대를 그리지 않는다.
        main.innerHTML = complete && total > 0
          ? `<svg class="encar-trade-ratio" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${activeText} (${activePercent.toFixed(1)}%), ${soldText} (${soldPercent.toFixed(1)}%)">
              <title>전체 연식의 현재 재고와 최근 30일 판매완료 건수의 상대 비율이며 판매확률이 아닙니다.</title>
              <rect width="${activePercent}" height="4" fill="#42A5F5" />
              <rect x="${activePercent}" width="${soldPercent}" height="4" fill="#EF5350" />
            </svg>`
          : `<div class="encar-trade-ratio-empty">${complete ? '비교할 매물 없음' : '집계 일부 · 비율 표시 불가'}</div>`;
        note.innerHTML = `<div class="encar-trade-legend"><span class="encar-trade-active">${activeText}${complete && total > 0 ? ` · ${activePercent.toFixed(1)}%` : ''}</span><span class="encar-trade-sold">${soldText}${complete && total > 0 ? ` · ${soldPercent.toFixed(1)}%` : ''}</span></div>`;
        const totalText = `매물 합계 ${total.toLocaleString()}건${complete ? '' : ' 이상 · 집계 일부'}`;
        const totalHelp = '동일 모델 세대·세부 트림의 모든 연식을 합산합니다. 매물 합계는 현재 판매 중 + 최근 30일 판매완료 기록이며 신규 등록 대수가 아닙니다. 재등록·중복 기록으로 고유 차량 수와 다를 수 있습니다.';
        scope.textContent = totalText;
        scope.title = totalHelp;
        clipboardExtras.activity = ['거래 현황: ' + activeText, soldText,
          totalText, `${d.scope} · ${d.start}~${d.end}`, `주의: ${totalHelp}`].join('\n');
        refreshClipboardText();
        activityLoadedAt = Date.now();
      } catch (error) {
        main.className = '';
        main.textContent = '조회 실패 · 툴팁을 다시 열면 재시도합니다';
        clipboardExtras.activity = '거래 현황: 조회 실패';
        refreshClipboardText();
        console.warn('[EncarScore] 거래 현황 조회 실패:', error);
      } finally {
        activityLoading = false;
        requestAnimationFrame(positionTooltip);
      }
    };

    // 툴팁이 잘리는 현상(overflow: hidden)을 방지하기 위해 body에 직접 삽입하여 fixed 좌표로 렌더링
    let closeTooltipTimer;
    const closeTooltip = () => {
      clearTimeout(closeTooltipTimer);
      tooltip.remove();
      window.removeEventListener('resize', positionTooltip);
    };
    const scheduleTooltipClose = () => {
      clearTimeout(closeTooltipTimer);
      closeTooltipTimer = setTimeout(closeTooltip, 200);
    };
    tooltip.addEventListener('mouseenter', () => clearTimeout(closeTooltipTimer));
    tooltip.addEventListener('mouseleave', scheduleTooltipClose);
    badge.addEventListener('mouseenter', () => {
      clearTimeout(closeTooltipTimer);
      document.body.appendChild(tooltip);
      tooltip.style.visibility = 'hidden';
      tooltip.style.display = 'block';
      positionTooltip();
      window.addEventListener('resize', positionTooltip);
      void loadTradeActivity();
      void loadDepreciation();
    });

    badge.addEventListener('mouseleave', event => {
      if (!event.isTrusted) closeTooltip();
      else scheduleTooltipClose();
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

  async function showAIModal(carId, clipboardText) {
    const CACHE_KEY = carId ? `encar_ai_${carId}` : null;

    const overlay = document.createElement('div');
    overlay.className = 'encar-ai-overlay';
    overlay.innerHTML = `
      <div class="encar-ai-modal">
        <div class="encar-ai-header">
          <span>🤖 AI 분석</span>
          <div class="encar-ai-header-actions">
            <button class="encar-ai-refresh" title="새로 분석">🔄</button>
            <button class="encar-ai-close">✕</button>
          </div>
        </div>
        <div class="encar-ai-meta" style="display:none"></div>
        <div class="encar-ai-body">
          <div class="encar-ai-loading">
            <div class="encar-ai-spinner"></div>
            <span>분석 중...</span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.encar-ai-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const body = overlay.querySelector('.encar-ai-body');
    const meta = overlay.querySelector('.encar-ai-meta');

    function showResult(text, savedAt) {
      body.innerHTML = `<div class="encar-ai-text">${text.replace(/\n/g, '<br>')}</div>`;
      if (savedAt) {
        meta.style.display = 'flex';
        meta.textContent = `저장: ${formatRelativeTime(new Date(savedAt).toISOString())}`;
      }
    }

    function fetchAndShow() {
      body.innerHTML = `<div class="encar-ai-loading"><div class="encar-ai-spinner"></div><span>분석 중...</span></div>`;
      meta.style.display = 'none';

      const port = chrome.runtime.connect({ name: 'openai-stream' });
      let textEl = null;
      let fullText = '';

      port.onMessage.addListener((msg) => {
        if (msg.type === 'chunk') {
          if (!textEl) {
            body.innerHTML = '';
            textEl = document.createElement('div');
            textEl.className = 'encar-ai-text';
            body.appendChild(textEl);
          }
          fullText += msg.chunk;
          textEl.innerHTML = fullText.replace(/\n/g, '<br>');
          // 스크롤 하단 유지
          body.scrollTop = body.scrollHeight;
        } else if (msg.type === 'done') {
          fullText = msg.text || fullText;
          if (textEl) textEl.innerHTML = fullText.replace(/\n/g, '<br>');
          const savedAt = Date.now();
          if (CACHE_KEY) {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ text: fullText, savedAt }));
            document.querySelectorAll(`[data-car-id="${carId}"]`).forEach(badge => {
              if (!badge.querySelector('.encar-ai-dot')) {
                const dot = document.createElement('div');
                dot.className = 'encar-ai-dot';
                badge.appendChild(dot);
              }
            });
          }
          if (savedAt) {
            meta.style.display = 'flex';
            meta.textContent = `저장: ${formatRelativeTime(new Date(savedAt).toISOString())}`;
          }
          port.disconnect();
        } else if (msg.type === 'error') {
          body.innerHTML = `<div class="encar-ai-error">${msg.error}</div>`;
          port.disconnect();
        }
      });

      port.postMessage({ type: 'ASK_OPENAI_STREAM', text: clipboardText });
    }

    overlay.querySelector('.encar-ai-refresh').addEventListener('click', fetchAndShow);

    // 캐시 먼저 확인
    if (CACHE_KEY) {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        try {
          const { text, savedAt } = JSON.parse(cached);
          showResult(text, savedAt);
          return;
        } catch { /* 파싱 실패 시 새로 요청 */ }
      }
    }

    fetchAndShow();
  }

  /**
   * 기본 배지는 즉시 표시하고, 비교 매물 점수는 백그라운드에서 채운 뒤
   * 같은 위치의 배지를 새 차트로 교체한다.
   */
  async function enrichBadgeWithMarketScores(badge, scoreResult, cardData, weights, fullData, config) {
    const market = fullData.marketPriceData;
    if (!market?.items?.length || market.scoresLoaded) return;

    try {
      const scoredMarket = await DetailParser.scoreMarketItems(
        market,
        weights,
        config,
        {
          carId: fullData.carId,
          score: scoreResult.total,
          yearlyMarketData: fullData.yearlyMarketData
        }
      );
      if (!badge.isConnected) return;

      const updatedBadge = createScoreBadge(
        scoreResult,
        cardData,
        weights,
        { ...fullData, marketPriceData: scoredMarket }
      );

      // 상세 페이지의 fixed 위치 등 기존 인라인 스타일을 그대로 유지한다.
      updatedBadge.style.cssText = badge.style.cssText;
      badge.dispatchEvent(new Event('mouseleave'));
      badge.replaceWith(updatedBadge);
    } catch (error) {
      console.warn('[EncarScore] 가격 구간 평균점수 계산 실패:', error);
    }
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

      // 사용자 가중치 불러오기
      const weights = await getStoredWeights();

      // 점수 계산
      const scoreResult = EncarScoring.calculateScore(fullData, weights);

      // 로딩 배지 제거 → 점수 배지 표시
      loadingBadge.remove();
      const scoreBadge = createScoreBadge(scoreResult, cardData, weights, fullData);
      parentEl.appendChild(scoreBadge);
      enrichBadgeWithMarketScores(
        scoreBadge,
        scoreResult,
        cardData,
        weights,
        fullData,
        {}
      );

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
      const scoreResult = EncarScoring.calculateScore(fullData, weights);

      loadingBadge.remove();
      const scoreBadge = createScoreBadge(scoreResult, { modelName }, weights, fullData);
      scoreBadge.style.cssText += '; position: fixed !important; bottom: 24px; right: 24px; width: 72px; height: 72px; z-index: 99999;';
      document.body.appendChild(scoreBadge);
      enrichBadgeWithMarketScores(
        scoreBadge,
        scoreResult,
        { modelName },
        weights,
        fullData,
        {}
      );

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
