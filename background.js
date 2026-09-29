/**
 * 엔카 품질 점수 - Background Service Worker
 */

importScripts('constants.js', 'openai.js');

const SOLD_OUT_URL = 'https://www.encar.com/dc/dc_carsearchpop.do';
const SOLD_OUT_PAGE_SIZE = 20;
const SOLD_OUT_MAX_PAGES = 20;

// 거래 현황은 가격 유무와 무관하게 판매일을 집계한다. 캐시는 워커 수명 내 30분.
const activityCache = new Map();
// 툴팁을 열면 여러 조회가 한꺼번에 나가 429(요청 과다)가 나기 쉬우므로 잠시 기다렸다 다시 요청한다.
const ACTIVITY_RETRY_DELAYS_MS = [1000, 2000, 4000];

async function activityFetch(url, html = false) {
  for (let attempt = 0; ; attempt++) {
    let response = null;
    let failure = null;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (error) {
      failure = error; // 네트워크 오류·시간 초과
    }
    if (response?.ok) {
      return html ? new TextDecoder('euc-kr').decode(await response.arrayBuffer()) : response.json();
    }
    // 429·5xx·네트워크 오류·시간 초과만 재시도한다. Retry-After가 있으면 따르되 10초를 넘기지 않는다.
    const retryable = !response || response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= ACTIVITY_RETRY_DELAYS_MS.length) {
      throw failure || new Error(`거래 현황 HTTP ${response.status}`);
    }
    const retryAfterMs = Number(response?.headers?.get?.('Retry-After')) * 1000;
    const delay = Math.min(10000, retryAfterMs > 0 ? retryAfterMs : ACTIVITY_RETRY_DELAYS_MS[attempt]);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

async function fetchTradeActivity(carId) {
  const vehicle = await activityFetch(`https://api.encar.com/v1/readside/vehicle/${carId}`);
  const c = vehicle.category;
  const year = String(c?.yearMonth || '').slice(0, 4);
  if (!/^\d{4}$/.test(year) || !c.modelName || !c.gradeName) throw new Error('차량 조건 확인 불가');
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const end = formatLocalDate(today);
  today.setDate(today.getDate() - 89);
  const start = formatLocalDate(today);
  const key = JSON.stringify([c.manufacturerCd, c.modelCd, c.gradeCd, c.gradeDetailCd, year, end]);
  const cached = activityCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    const actualId = String(vehicle.vehicleId || carId);
    let sold = 0, soldComplete = false, previousDate = '9999/99/99';
    const pageSignatures = new Set();
    for (let page = 1; page <= 20; page++) {
      const url = new URL(SOLD_OUT_URL);
      Object.entries({method: 'soldoutCars', carTypeCd: '1', carid: actualId, pagenum: String(page)})
        .forEach(([name, value]) => url.searchParams.set(name, value));
      const html = await activityFetch(url, true);
      const parsed = parseSoldOutPage(html), f = parsed.filters;
      if (parsed.requestedCarId !== actualId || f.manufacturerCd !== c.manufacturerCd ||
          f.modelCd !== c.modelCd || f.gradeCd !== c.gradeCd ||
          f.gradeDetailCd !== (c.gradeDetailCd || '') ||
          f.startYearMonth !== `${year}01` || f.endYearMonth !== `${year}12` ||
          !/class=["'][^"']*part\s+result[^"']*["']/i.test(html)) {
        throw new Error('판매완료 검색 조건 확인 불가');
      }
      const dates = [...html.matchAll(/<td\b[^>]*class=["'][^"']*\bfdt\b[^"']*["'][^>]*>\s*(\d{4}\/\d{2}\/\d{2})/gi)].map(m => m[1]);
      if (!dates.length && parsed.total > 0) throw new Error('판매일 파싱 실패');
      const signature = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || dates.join(',');
      if (dates.length && pageSignatures.has(signature)) throw new Error('판매완료 페이지 반복');
      pageSignatures.add(signature);
      for (const date of dates) {
        if (date > previousDate) throw new Error('판매일 정렬 확인 불가');
        previousDate = date;
        if (date >= start && date <= end) sold++;
      }
      if (dates.some(date => date < start) || page * 20 >= parsed.total) { soldComplete = true; break; }
      if (dates.length !== 20) throw new Error('판매완료 페이지 누락');
    }
    // 모델/연도 후보를 모두 받은 뒤 정확한 트림과 중복 광고를 로컬에서 필터링한다.
    if (!c.modelGroupName || /[.\r\n]/.test(c.modelGroupName)) throw new Error('검색 모델 그룹 확인 불가');
    const modelFilter = /[.\r\n]/.test(c.modelName) ? '' : `_.Model.${c.modelName}.`;
    const q = `(And.Hidden.N._.ModelGroup.${c.modelGroupName}.${modelFilter}_.Year.range(${year}01..${year}12).)`;
    const ids = new Set();
    let total = Infinity, loaded = 0;
    for (let offset = 0; offset < total && offset < 5000; offset += 500) {
      const url = new URL('https://api.encar.com/search/car/list/general');
      Object.entries({q, sr: `|ModifiedDate|${offset}|500`, count: 'true'})
        .forEach(([name, value]) => url.searchParams.set(name, value));
      const data = await activityFetch(url);
      if (!Number.isFinite(data.Count) || !Array.isArray(data.SearchResults)) throw new Error('현재 매물 응답 오류');
      total = data.Count;
      loaded += data.SearchResults.length;
      for (const row of data.SearchResults) {
        if (row.Model === c.modelName && row.Badge === c.gradeName && String(row.Year).slice(0, 4) === year &&
            (!c.gradeDetailName || c.gradeDetailName === '없음' || row.BadgeDetail === c.gradeDetailName) &&
            row.ServiceCopyCar !== 'DUPLICATION' && row.Id) ids.add(String(row.Id));
      }
      if (!data.SearchResults.length && offset < total) throw new Error('현재 매물 페이지 누락');
    }
    return { sold, active: ids.size, soldComplete, activeComplete: loaded >= total,
      start, end, scope: `${c.modelName} ${c.gradeName} ${c.gradeDetailName || ''} · ${year}년 등록`,
      fetchedAt: Date.now() };
  })();
  if (activityCache.size > 100) activityCache.delete(activityCache.keys().next().value);
  activityCache.set(key, { promise, expires: Date.now() + 30 * 60 * 1000 });
  promise.catch(() => activityCache.delete(key));
  return promise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'FETCH_ENCAR_TRADE_ACTIVITY') return false;
  if (!/^https:\/\/fem\.encar\.com\/cars\/detail\//.test(sender.url || '') || !/^\d+$/.test(String(message.carId))) {
    sendResponse({ ok: false, error: '상세 페이지 전용 요청' });
    return false;
  }
  fetchTradeActivity(String(message.carId)).then(data => sendResponse({ok: true, data}))
    .catch(error => sendResponse({ok: false, error: error.message}));
  return true;
});

function parseSoldOutPrice(text) {
  const normalized = String(text || '').replace(/<[^>]*>/g, ' ').replace(/,/g, '');
  const match = normalized.match(/\b(\d{2,6})\b/);
  return match ? parseInt(match[1], 10) : null;
}

function getHiddenInputValue(html, id) {
  for (const inputMatch of html.matchAll(/<input\b[^>]*>/gi)) {
    const input = inputMatch[0];
    const inputId = input.match(/\bid=["']([^"']*)["']/i)?.[1];
    if (inputId !== id) continue;
    return input.match(/\bvalue=["']([^"']*)["']/i)?.[1] || '';
  }
  return '';
}

/** legacy 판매완료 HTML에서 첫 번째 '가격' 열과 판매일을 추출한다. */
function parseSoldOutPage(html) {
  const requestedCarId = getHiddenInputValue(html, 'carid');
  const totalText = html.match(/class=["'][^"']*part\s+result[^"']*["'][\s\S]*?<strong>\s*([\d,]+)/i)?.[1] || '0';
  const total = parseInt(totalText.replace(/,/g, ''), 10) || 0;
  const rows = [];

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1];
    const priceCell = rowHtml.match(/<td\b[^>]*class=["'][^"']*\bprc\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
    const soldDate = rowHtml.match(/<td\b[^>]*class=["'][^"']*\bfdt\b[^"']*["'][^>]*>\s*(\d{4}\/\d{2}\/\d{2})/i)?.[1];
    const price = priceCell ? parseSoldOutPrice(priceCell[1]) : null;
    if (price && soldDate) rows.push({ price, soldDate });
  }

  return {
    requestedCarId,
    total,
    rows,
    filters: {
      manufacturerCd: getHiddenInputValue(html, 'mnfccd'),
      modelGroupCd: getHiddenInputValue(html, 'mdlgroupcd'),
      modelCd: getHiddenInputValue(html, 'mdlcd'),
      gradeGroupCd: getHiddenInputValue(html, 'headfiltercd'),
      gradeCd: getHiddenInputValue(html, 'clsheadcd'),
      gradeDetailCd: getHiddenInputValue(html, 'clsdetailcd'),
      startYearMonth: getHiddenInputValue(html, 'styear'),
      endYearMonth: getHiddenInputValue(html, 'endyear')
    }
  };
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function filterSoldOutliers(prices, referencePrice) {
  let filtered = prices.filter(price => Number.isFinite(price) && price > 0);

  // 9,999만원 상담가처럼 동급 차량 가격과 명백히 동떨어진 입력값만 제외한다.
  if (Number.isFinite(referencePrice) && referencePrice > 0) {
    const lower = referencePrice * 0.25;
    const upper = referencePrice * 4;
    const plausible = filtered.filter(price => price >= lower && price <= upper);
    if (plausible.length >= Math.min(3, filtered.length)) filtered = plausible;
  }

  // 동일 연식·트림 내부의 일반적인 가격 범위도 계산한다.
  // 표본이 충분할 때 Tukey IQR(1.5배) 밖의 값은 평균을 왜곡하는 아웃라이어로 제외한다.
  if (filtered.length >= 8) {
    const sorted = [...filtered].sort((a, b) => a - b);
    const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)];
    const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)];
    const iqr = q3 - q1;
    if (iqr > 0) {
      const lower = q1 - iqr * 1.5;
      const upper = q3 + iqr * 1.5;
      const withinIqr = filtered.filter(price => price >= lower && price <= upper);
      // 가격대가 비정상적으로 좁거나 표본이 무너지는 경우에는 통계 필터를 적용하지 않는다.
      if (withinIqr.length >= Math.max(3, Math.ceil(filtered.length * 0.5))) {
        filtered = withinIqr;
      }
    }
  }

  return filtered;
}

async function fetchSoldOutAverage(carId, referencePrice = 0, search = null) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const todayText = formatLocalDate(now);
  const cutoffText = formatLocalDate(cutoff);
  const prices = [];
  let totalPages = 1;
  let pagesFetched = 0;
  let cutoffReached = false;

  for (let pageNo = 1; pageNo <= Math.min(totalPages, SOLD_OUT_MAX_PAGES); pageNo++) {
    const url = new URL(SOLD_OUT_URL);
    url.searchParams.set('method', 'soldoutCars');
    url.searchParams.set('carTypeCd', '1');
    if (search) {
      url.searchParams.set('carType', search.carType === 'kor' ? 'kor' : 'for');
      url.searchParams.set('mnfccd', search.filters.manufacturerCd);
      url.searchParams.set('mdlgroupcd', search.filters.modelGroupCd);
      url.searchParams.set('mdlcd', search.filters.modelCd);
      url.searchParams.set('headfiltercd', search.filters.gradeGroupCd);
      url.searchParams.set('clsheadcd', search.broadenTrim ? '' : search.filters.gradeCd);
      url.searchParams.set('clsdetailcd', search.broadenTrim ? '' : search.filters.gradeDetailCd);
      url.searchParams.set('styear', `${search.year}01`);
      url.searchParams.set('endyear', `${search.year}12`);
    } else {
      url.searchParams.set('carid', carId);
    }
    url.searchParams.set('pagenum', String(pageNo));

    const response = await fetch(url.toString(), {
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!response.ok) throw new Error(`판매완료 조회 HTTP ${response.status}`);

    const html = new TextDecoder('euc-kr').decode(await response.arrayBuffer());
    const parsed = parseSoldOutPage(html);
    pagesFetched++;

    // 잘못된 ID가 전체 판매완료 목록(수십만 건)으로 풀리는 것을 차단한다.
    if (pageNo === 1) {
      if (!search && parsed.requestedCarId !== String(carId)) return null;
      totalPages = Math.max(1, Math.ceil(parsed.total / SOLD_OUT_PAGE_SIZE));
    }

    let reachedCutoff = false;
    for (const row of parsed.rows) {
      if (row.soldDate < cutoffText) {
        reachedCutoff = true;
        continue;
      }
      if (row.soldDate <= todayText) prices.push(row.price);
    }

    if (reachedCutoff) cutoffReached = true;
    if (reachedCutoff || parsed.rows.length === 0) break;
  }

  if (prices.length === 0) return null;
  const filtered = filterSoldOutliers(prices, Number(referencePrice));
  if (filtered.length === 0) return null;

  return {
    average: Math.round(filtered.reduce((sum, price) => sum + price, 0) / filtered.length),
    count: filtered.length,
    excludedCount: prices.length - filtered.length,
    cutoffDate: cutoffText,
    pagesFetched,
    truncated: !cutoffReached && totalPages > SOLD_OUT_MAX_PAGES && pagesFetched >= SOLD_OUT_MAX_PAGES
  };
}

async function fetchSoldOutMetadata(carId) {
  const url = new URL(SOLD_OUT_URL);
  url.searchParams.set('method', 'soldoutCars');
  url.searchParams.set('carTypeCd', '1');
  url.searchParams.set('carid', carId);
  url.searchParams.set('pagenum', '1');

  const response = await fetch(url.toString(), {
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'Accept': 'text/html,application/xhtml+xml' }
  });
  if (!response.ok) throw new Error(`판매완료 조건 조회 HTTP ${response.status}`);

  const html = new TextDecoder('euc-kr').decode(await response.arrayBuffer());
  const parsed = parseSoldOutPage(html);
  if (parsed.requestedCarId !== String(carId)) return null;
  if (
    !parsed.filters.manufacturerCd ||
    !parsed.filters.modelCd ||
    (!parsed.filters.gradeGroupCd && !parsed.filters.gradeCd)
  ) return null;
  return parsed.filters;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  ));
  return results;
}

async function fetchSoldOutYearlyAverages(carId, yearReferences, carType, broadenTrim = false) {
  const filters = await fetchSoldOutMetadata(carId);
  if (!filters) return null;

  const currentYear = new Date().getFullYear();
  const references = (Array.isArray(yearReferences) ? yearReferences : [])
    .map(item => ({
      year: Number(item?.year),
      referencePrice: Number(item?.referencePrice) || 0
    }))
    .filter(item => Number.isInteger(item.year) && item.year >= 1980 && item.year <= currentYear)
    .filter((item, index, array) => array.findIndex(other => other.year === item.year) === index)
    .slice(0, 25);
  if (references.length === 0) return null;

  const results = await mapWithConcurrency(references, 3, async reference => {
    try {
      const data = await fetchSoldOutAverage('', reference.referencePrice, {
        filters,
        year: reference.year,
        carType,
        broadenTrim: broadenTrim && Boolean(filters.gradeGroupCd)
      });
      return data ? { year: reference.year, ...data } : null;
    } catch (error) {
      console.warn(`[EncarScore] ${reference.year}년식 판매완료 평균가 조회 실패:`, error);
      return null;
    }
  });

  const points = results.filter(Boolean).sort((a, b) => b.year - a.year);
  return points.length > 0 ? { points } : null;
}

// 설치 시 기본 설정 (DEFAULT_WEIGHTS는 constants.js에서 로드)
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    weights: DEFAULT_WEIGHTS,
    minScore: 0
  });
  console.log('[EncarScore] 익스텐션 설치 완료');
});

// 판매완료 페이지는 EUC-KR HTML이며 CORS 대상이므로 서비스 워커에서 대신 조회한다.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const isSingleYear = message?.type === 'FETCH_ENCAR_SOLD_OUT_AVERAGE';
  const isAllYears = message?.type === 'FETCH_ENCAR_SOLD_OUT_YEARLY_AVERAGES';
  if (!isSingleYear && !isAllYears) return false;

  const carId = String(message.carId || '');
  if (!/^\d+$/.test(carId)) {
    sendResponse({ ok: false, error: '잘못된 차량 ID' });
    return false;
  }

  const request = isAllYears
    ? fetchSoldOutYearlyAverages(
        carId,
        message.yearReferences,
        message.carType,
        message.broadenTrim === true
      )
    : fetchSoldOutAverage(carId, Number(message.referencePrice) || 0);

  request
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => {
      console.warn('[EncarScore] 판매완료 평균가 조회 실패:', error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

// OpenAI API 스트리밍 호출 (포트 연결 방식)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'openai-stream') return;

  port.onMessage.addListener(async (message) => {
    if (message.type !== 'ASK_OPENAI_STREAM') return;

    const result = await chrome.storage.local.get(['openaiApiKey']);
    const apiKey = result.openaiApiKey?.trim();
    if (!apiKey) {
      port.postMessage({ type: 'error', error: 'API 키가 설정되지 않았습니다. 팝업에서 키를 입력해주세요.' });
      return;
    }

    try {
      const fullText = await askOpenAIStream(message.text, apiKey, (chunk) => {
        port.postMessage({ type: 'chunk', chunk });
      });
      port.postMessage({ type: 'done', text: fullText });
    } catch (err) {
      port.postMessage({ type: 'error', error: err.message });
    }
  });
});

// 탭 업데이트 시 아이콘 상태 관리
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (tab.url.includes('car.encar.com/list')) {
      // 엔카 리스트 페이지 → 아이콘 활성화
      chrome.action.setIcon({
        tabId,
        path: {
          16: 'icons/icon16.png',
          48: 'icons/icon48.png',
          128: 'icons/icon128.png'
        }
      });
    }
  }
});
