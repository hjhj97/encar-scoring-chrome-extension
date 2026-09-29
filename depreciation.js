/**
 * 엔카 품질 점수 - 감가곡선 추정
 *
 * 같은 모델 그룹(여러 세대·트림)의 판매 중 매물을 한 번에 회귀해 경과연수별 감가곡선을 추정한다.
 *
 *   log(가격) = 세대·트림 기준값 + Σ 구간기울기 × 구간길이(경과연수) + 주행거리 계수 × 주행거리(만km)
 *
 *  - 세대·트림 기준값: (Model, Badge) 그룹마다 따로 두어 세대·트림 간 가격 수준 차이를 흡수한다.
 *    그룹 평균을 빼는 방식(within 변환)으로 제거하므로 실제로 푸는 변수는 구간기울기 + 주행거리 계수뿐이다.
 *  - 구간기울기·주행거리 계수는 0 이하로 제한한다. (나이·주행이 늘면서 가격이 오르지 않음)
 *  - 인접 구간 기울기 차이에 벌점을 줘 세대 교체·연식 변경 잡음에 곡선이 흔들리지 않게 한다.
 *  - Huber 가중치로 반복 재추정해 상담가·사고차 같은 이상치 영향을 줄인다.
 *
 * 같은 시점의 여러 연식을 비교한 횡단면 곡선이므로 한 차량을 시간에 따라 추적한 값이 아니며,
 * 신차 → 1년차 첫 감가와 향후 시세 전체의 변동은 반영하지 않는다.
 */
const EncarDepreciation = (() => {

  // 경과연수 구간 경계. 초기에는 1년 단위, 이후 표본이 줄어드는 구간은 넓게 둔다.
  const AGE_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20];
  const SEGMENT_COUNT = AGE_EDGES.length - 1;
  const FEATURE_COUNT = SEGMENT_COUNT + 1; // 구간기울기 + 주행거리 계수

  const SEARCH_PAGE_SIZE = 500;
  // 최근 수정순 2,000대(요청 4회). 중복 광고(약 30%)를 빼면 1,300대 안팎이 남고 전체 표본 곡선과 1%p 안팎으로 일치
  const SEARCH_MAX_ROWS = 2000;
  // 표본 150대에서 전체 표본 곡선 대비 오차 중앙값 1~3%p. 500대 미만이면 부트스트랩 범위를 함께 제공한다.
  const MIN_SAMPLE_COUNT = 150;
  const MIN_GROUP_COUNT = 5;
  const MIN_AGE_SPAN = 4;
  const SMOOTHING = 30;
  const HUBER_K = 1.345;
  const IRLS_ITERATIONS = 15;
  const BOOTSTRAP_BELOW = 500;
  const BOOTSTRAP_ITERATIONS = 50;
  const BOOTSTRAP_MIN_SUCCESS = 30;

  // 감가 4단계: 신차가 대비 연 감가(1년 후 예상 하락액 ÷ 신차가) 기준.
  // 현재가 대비 비율은 오래된 차도 연 6~9%로 이어져 15년 넘은 300만원대 차가 '가파른 감가'로 나오므로
  // 신차가 대비 금액으로 판단한다. 9개 모델 그룹(그랜저·아반떼·쏘나타·쏘렌토·K5·레이·BMW 5·E-클래스·A5)
  // 매물 2.8만 대 분포: 하위 10% 3.1%p · 중앙 4.7%p · 상위 10% 7.7%p.
  // 각 단계 비중 약 20% / 48% / 28% / 4%, 해당 매물 중앙 연식 3년 / 6년 / 11년 / 15년.
  const RATE_LEVELS = [
    { min: 0.065, key: 'steep', label: '가파른 감가' },
    { min: 0.04, key: 'average', label: '평균적 감가' },
    { min: 0.025, key: 'gentle', label: '완만한 감가' },
    { min: -Infinity, key: 'flat', label: '감가 둔화' }
  ];

  const CACHE_VERSION = 2;
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const curveCache = new Map();

  /** 경과연수를 구간별 길이로 분해한다. 예: 2.5년 → [1, 1, 0.5, 0, ...] */
  function ageSegments(age) {
    const segments = new Array(SEGMENT_COUNT);
    for (let j = 0; j < SEGMENT_COUNT; j++) {
      const start = AGE_EDGES[j];
      const end = AGE_EDGES[j + 1];
      segments[j] = Math.min(Math.max(age - start, 0), end - start);
    }
    return segments;
  }

  /** 곡선의 log 가격 변화량(0년 기준) */
  function curveLogValue(curve, age) {
    const segments = ageSegments(age);
    let value = 0;
    for (let j = 0; j < SEGMENT_COUNT; j++) value += curve.slopes[j] * segments[j];
    return value;
  }

  /**
   * 검색 API 매물 1건을 회귀용 표본으로 변환한다.
   * 렌트·리스(인도금 가격), 중복 광고, 상담가(9,999만원)는 기존 시세 조회와 같은 기준으로 제외한다.
   */
  function parseListing(item, now = new Date()) {
    const price = item?.Price;
    const mileage = item?.Mileage;
    const model = String(item?.Model || '').trim();
    const yearMonth = String(Math.trunc(Number(item?.Year) || 0));
    if (typeof price !== 'number' || price <= 50 || price >= 9999) return null;
    if (typeof mileage !== 'number' || mileage < 0) return null;
    if (!model || !/^(19|20)\d{4}$/.test(yearMonth)) return null;
    if (item.SellType === '렌트' || item.SellType === '리스' || item.LeaseType) return null;
    if (item.ServiceCopyCar === 'DUPLICATION') return null;

    const year = parseInt(yearMonth.slice(0, 4), 10);
    const month = parseInt(yearMonth.slice(4, 6), 10);
    if (month < 1 || month > 12) return null;
    const age = (now.getFullYear() - year) + (now.getMonth() + 1 - month) / 12;
    if (age < 0 || age > AGE_EDGES[AGE_EDGES.length - 1]) return null;

    return {
      group: `${model}::${String(item.Badge || '').trim()}`,
      age,
      km: mileage / 10000,
      logPrice: Math.log(price)
    };
  }

  function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** 작은 대칭 선형계 풀이 (부분 피벗 가우스 소거). 특이하면 null */
  function solveLinearSystem(matrix, vector) {
    const n = vector.length;
    const a = matrix.map((row, i) => [...row, vector[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      }
      if (Math.abs(a[pivot][col]) < 1e-12) return null;
      [a[col], a[pivot]] = [a[pivot], a[col]];
      for (let row = col + 1; row < n; row++) {
        const factor = a[row][col] / a[col][col];
        for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let row = n - 1; row >= 0; row--) {
      let sum = a[row][n];
      for (let k = row + 1; k < n; k++) sum -= a[row][k] * x[k];
      x[row] = sum / a[row][row];
    }
    return x;
  }

  /**
   * 정규방정식 형태의 비음수 최소제곱 (Lawson–Hanson).
   * min ½uᵀGu − hᵀu, u ≥ 0 을 푼다. G = CᵀC, h = Cᵀd.
   */
  function solveNonNegative(G, h) {
    const n = h.length;
    const tolerance = 1e-10;
    const x = new Array(n).fill(0);
    const passive = new Array(n).fill(false);
    const gradient = () => h.map((value, i) => value - G[i].reduce((sum, g, j) => sum + g * x[j], 0));

    const solvePassive = () => {
      const indices = [];
      for (let i = 0; i < n; i++) if (passive[i]) indices.push(i);
      const sub = solveLinearSystem(
        indices.map(i => indices.map(j => G[i][j])),
        indices.map(i => h[i])
      );
      const z = new Array(n).fill(0);
      if (sub) indices.forEach((index, k) => { z[index] = sub[k]; });
      return sub ? z : null;
    };

    for (let outer = 0; outer < 3 * n; outer++) {
      const w = gradient();
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (!passive[i] && w[i] > tolerance && (best < 0 || w[i] > w[best])) best = i;
      }
      if (best < 0) break;
      passive[best] = true;

      for (let inner = 0; inner < 3 * n; inner++) {
        const z = solvePassive();
        if (!z) { passive[best] = false; return x; }
        let feasible = true;
        for (let i = 0; i < n; i++) if (passive[i] && z[i] <= tolerance) feasible = false;
        if (feasible) {
          for (let i = 0; i < n; i++) x[i] = z[i];
          break;
        }
        // 음수가 된 변수가 경계에 닿을 때까지만 이동한 뒤 활성 집합에서 제외한다.
        let alpha = Infinity;
        for (let i = 0; i < n; i++) {
          if (passive[i] && z[i] <= tolerance) alpha = Math.min(alpha, x[i] / (x[i] - z[i]));
        }
        for (let i = 0; i < n; i++) {
          x[i] += alpha * (z[i] - x[i]);
          if (passive[i] && x[i] <= tolerance) { passive[i] = false; x[i] = 0; }
        }
      }
    }
    return x;
  }

  /** 회귀에 쓰는 표본(매물 5대 이상인 세대·트림)과 그 연식 범위 */
  function usableSamples(listings) {
    const counts = new Map();
    for (const listing of listings) counts.set(listing.group, (counts.get(listing.group) || 0) + 1);
    const samples = listings.filter(listing => counts.get(listing.group) >= MIN_GROUP_COUNT);
    if (samples.length === 0) return { samples, minAge: 0, maxAge: 0 };
    const ages = samples.map(sample => sample.age);
    return { samples, minAge: Math.min(...ages), maxAge: Math.max(...ages) };
  }

  /** 추정할 수 없는 이유. 추정 가능하면 null */
  function insufficiencyReason(listings) {
    const { samples, minAge, maxAge } = usableSamples(listings);
    if (samples.length < MIN_SAMPLE_COUNT) return `표본 부족 (${samples.length.toLocaleString()}대, 최소 ${MIN_SAMPLE_COUNT}대)`;
    if (maxAge - minAge < MIN_AGE_SPAN) return `연식 범위 부족 (${minAge.toFixed(1)}~${maxAge.toFixed(1)}년)`;
    return null;
  }

  /**
   * 매물 표본으로 감가곡선을 추정한다.
   * 표본·연식 범위가 부족하면 null을 반환한다.
   */
  function fitCurve(listings) {
    const { samples, minAge, maxAge } = usableSamples(listings);
    if (samples.length < MIN_SAMPLE_COUNT || maxAge - minAge < MIN_AGE_SPAN) return null;

    const features = samples.map(sample => [...ageSegments(sample.age), sample.km]);
    const groupIndex = new Map();
    const sampleGroups = samples.map(sample => {
      if (!groupIndex.has(sample.group)) groupIndex.set(sample.group, groupIndex.size);
      return groupIndex.get(sample.group);
    });
    const groupCount = groupIndex.size;
    const penalty = SMOOTHING * samples.length / 1000;

    let weights = new Array(samples.length).fill(1);
    let coefficients = new Array(FEATURE_COUNT).fill(0);
    let residualScale = 0;

    for (let iteration = 0; iteration < IRLS_ITERATIONS; iteration++) {
      // 가중 그룹 평균 제거 (세대·트림 기준값 소거)
      const weightSum = new Array(groupCount).fill(0);
      const featureMean = Array.from({ length: groupCount }, () => new Array(FEATURE_COUNT).fill(0));
      const priceMean = new Array(groupCount).fill(0);
      samples.forEach((sample, i) => {
        const g = sampleGroups[i];
        weightSum[g] += weights[i];
        priceMean[g] += weights[i] * sample.logPrice;
        for (let k = 0; k < FEATURE_COUNT; k++) featureMean[g][k] += weights[i] * features[i][k];
      });
      for (let g = 0; g < groupCount; g++) {
        priceMean[g] /= weightSum[g];
        for (let k = 0; k < FEATURE_COUNT; k++) featureMean[g][k] /= weightSum[g];
      }

      // 계수 ≤ 0 제약은 u = −계수 ≥ 0 으로 바꿔 비음수 최소제곱으로 푼다.
      const G = Array.from({ length: FEATURE_COUNT }, () => new Array(FEATURE_COUNT).fill(0));
      const h = new Array(FEATURE_COUNT).fill(0);
      const centered = samples.map((sample, i) => {
        const g = sampleGroups[i];
        const x = features[i].map((value, k) => value - featureMean[g][k]);
        const y = sample.logPrice - priceMean[g];
        for (let a = 0; a < FEATURE_COUNT; a++) {
          h[a] -= weights[i] * x[a] * y;
          for (let b = a; b < FEATURE_COUNT; b++) G[a][b] += weights[i] * x[a] * x[b];
        }
        return { x, y };
      });
      for (let j = 0; j < SEGMENT_COUNT - 1; j++) {
        G[j][j] += penalty;
        G[j + 1][j + 1] += penalty;
        G[j][j + 1] -= penalty;
      }
      for (let a = 0; a < FEATURE_COUNT; a++) {
        for (let b = 0; b < a; b++) G[a][b] = G[b][a];
      }

      const next = solveNonNegative(G, h).map(value => -value);
      const residuals = centered.map(({ x, y }) => y - x.reduce((sum, value, k) => sum + value * next[k], 0));
      const center = median(residuals);
      residualScale = 1.4826 * median(residuals.map(value => Math.abs(value - center)));
      const change = Math.max(...next.map((value, k) => Math.abs(value - coefficients[k])));
      coefficients = next;
      if (residualScale <= 0 || change < 1e-7) break;
      const cutoff = HUBER_K * residualScale;
      weights = residuals.map(value => (Math.abs(value) <= cutoff ? 1 : cutoff / Math.abs(value)));
    }

    const kmPerYear = median(samples.filter(sample => sample.age >= 1).map(sample => sample.km / sample.age));
    return {
      version: CACHE_VERSION,
      slopes: coefficients.slice(0, SEGMENT_COUNT),
      mileageCoef: coefficients[SEGMENT_COUNT],
      typicalKmPerYear: kmPerYear,
      sampleCount: samples.length,
      groupCount,
      minAge,
      maxAge,
      residualScale
    };
  }

  /** 재현 가능한 난수 (mulberry32). 같은 표본이면 같은 범위가 나오도록 고정 시드를 쓴다. */
  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 부트스트랩: 매물을 복원추출해 곡선을 다시 추정한다. 캐시 크기를 줄이려고 곡선 계수만 보관한다.
   * 한 번 추정에 수 ms가 걸리므로 5회마다 메인 스레드에 양보해 페이지가 멈추지 않게 한다.
   * 성공한 추정이 적으면 범위를 믿을 수 없으므로 null을 반환한다.
   */
  async function bootstrapCurves(listings, iterations = BOOTSTRAP_ITERATIONS, seed = 1) {
    const random = seededRandom(seed);
    const curves = [];
    for (let i = 0; i < iterations; i++) {
      const resampled = listings.map(() => listings[Math.floor(random() * listings.length)]);
      const curve = fitCurve(resampled);
      if (curve) {
        curves.push({ slopes: curve.slopes, mileageCoef: curve.mileageCoef, typicalKmPerYear: curve.typicalKmPerYear });
      }
      if (i % 5 === 4) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return curves.length >= BOOTSTRAP_MIN_SUCCESS ? curves : null;
  }

  /** 신차가 대비 연 감가 → 4단계 ({ key, label }) */
  function rateLevel(originRate) {
    return RATE_LEVELS.find(level => originRate >= level.min);
  }

  function quantile(sortedValues, q) {
    const position = (sortedValues.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.min(sortedValues.length - 1, lower + 1);
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
  }

  /**
   * 현재 차량의 1년 뒤 감가를 추정한다.
   * 연식 효과는 곡선 기울기, 주행 효과는 모델 그룹의 전형적 연간 주행거리로 계산한다.
   * 앞으로의 주행은 전 차주가 아니라 구매자에게 달려 있고, 지금까지 많이 탄 이력은
   * 이미 현재 가격에 반영돼 있으므로 이 차량의 과거 주행 패턴을 이어 붙이지 않는다.
   *
   * 단계(level)는 신차가 대비 연 감가로 판단하므로 originPrice가 없으면 null이다.
   */
  function estimate(curve, { age, price = 0, originPrice = 0 }) {
    if (!curve || !Number.isFinite(age) || age < 0) return null;
    const yearRate = sample => 1 - Math.exp(
      curveLogValue(sample, age + 1) - curveLogValue(sample, age) + sample.mileageCoef * sample.typicalKmPerYear
    );
    const kmPerYear = curve.typicalKmPerYear;
    const ageStep = curveLogValue(curve, age + 1) - curveLogValue(curve, age);
    const mileageStep = curve.mileageCoef * kmPerYear;
    const totalRate = 1 - Math.exp(ageStep + mileageStep);
    // 신차가 대비 연 감가 = 1년 후 예상 하락액 ÷ 신차가 = 현재가 대비 감가율 × (현재가 ÷ 신차가)
    const priceToOrigin = price > 0 && originPrice > 0 ? price / originPrice : null;
    const originRate = priceToOrigin !== null ? totalRate * priceToOrigin : null;
    // 표본이 적은 모델 그룹은 부트스트랩 곡선들의 5~95% 범위를 함께 제공한다.
    const rates = Array.isArray(curve.bootstrap) ? curve.bootstrap.map(yearRate).sort((a, b) => a - b) : [];
    const rateRange = rates.length > 0 ? [quantile(rates, 0.05), quantile(rates, 0.95)] : null;
    return {
      totalRate,
      originRate,
      level: originRate !== null ? rateLevel(originRate) : null,
      rateRange,
      originRateRange: rateRange && priceToOrigin !== null ? rateRange.map(rate => rate * priceToOrigin) : null,
      ageRate: 1 - Math.exp(ageStep),
      mileageRate: 1 - Math.exp(mileageStep),
      kmPerYear,
      yearLoss: price > 0 ? price * totalRate : 0,
      mileageRatePer10k: 1 - Math.exp(curve.mileageCoef),
      // 표본 연식 범위를 벗어난 구간은 평활화로 이어 붙인 값이다.
      extrapolated: age < curve.minAge - 0.5 || age + 1 > curve.maxAge + 0.5
    };
  }

  /**
   * 차트용 곡선 가격. 연식별 평균 판매가(points)에 곡선 수준을 맞춘다.
   * points: [{ age(정수 경과연수), avgPrice, count }], ageShift: 정수 연식 → 평균 경과연수 보정
   */
  function fitLevelToPoints(curve, points, ageShift) {
    let weighted = 0;
    let weightSum = 0;
    for (const point of points) {
      if (!Number.isFinite(point?.age) || !(point.avgPrice > 0) || !(point.count > 0)) continue;
      const age = Math.max(0, point.age + ageShift);
      const base = curveLogValue(curve, age) + curve.mileageCoef * curve.typicalKmPerYear * age;
      weighted += point.count * (Math.log(point.avgPrice) - base);
      weightSum += point.count;
    }
    if (weightSum <= 0) return null;
    const level = weighted / weightSum;
    return age => Math.exp(level + curveLogValue(curve, age) + curve.mileageCoef * curve.typicalKmPerYear * age);
  }

  async function readStoredCurve(key) {
    try {
      if (!chrome?.storage?.local) return null;
      const result = await chrome.storage.local.get([key]);
      const stored = result?.[key];
      if (!stored || stored.curve?.version !== CACHE_VERSION) return null;
      if (Date.now() - stored.savedAt > CACHE_TTL_MS) return null;
      return stored.curve;
    } catch {
      return null;
    }
  }

  function writeStoredCurve(key, curve) {
    try {
      chrome?.storage?.local?.set({ [key]: { savedAt: Date.now(), curve } });
    } catch { /* 저장 실패 시 메모리 캐시만 사용 */ }
  }

  async function fetchListings(modelGroupName) {
    const q = `(And.Hidden.N._.ModelGroup.${encodeURIComponent(modelGroupName)}.)`;
    const listings = [];
    const now = new Date();
    for (let offset = 0; offset < SEARCH_MAX_ROWS; offset += SEARCH_PAGE_SIZE) {
      const url = `https://api.encar.com/search/car/list/general?q=${q}&sr=%7CModifiedDate%7C${offset}%7C${SEARCH_PAGE_SIZE}&count=true`;
      const res = await fetch(url, { credentials: 'omit', headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`감가곡선 매물 조회 HTTP ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data?.SearchResults) ? data.SearchResults : [];
      for (const row of rows) {
        const listing = parseListing(row, now);
        if (listing) listings.push(listing);
      }
      if (rows.length < SEARCH_PAGE_SIZE || offset + SEARCH_PAGE_SIZE >= (data?.Count ?? 0)) break;
    }
    return listings;
  }

  /**
   * 모델 그룹 감가곡선 조회 (메모리 + chrome.storage 24시간 캐시).
   * 표본이 부족하면 { curve: null, reason } 을 반환한다.
   */
  function fetchCurve(modelGroupName) {
    const name = String(modelGroupName || '').trim();
    // 검색 DSL은 마침표를 구분자로 쓰므로 마침표가 들어간 모델 그룹은 조회하지 않는다.
    if (!name || name.includes('.')) return Promise.resolve({ curve: null, reason: '모델 그룹 확인 불가' });
    if (curveCache.has(name)) return curveCache.get(name);

    const key = `encarDepreciation:v${CACHE_VERSION}:${name}`;
    const promise = (async () => {
      const stored = await readStoredCurve(key);
      if (stored) return { curve: stored, reason: null };

      const listings = await fetchListings(name);
      const curve = fitCurve(listings);
      if (!curve) return { curve: null, reason: insufficiencyReason(listings) || '추정 실패' };
      if (curve.sampleCount < BOOTSTRAP_BELOW) curve.bootstrap = await bootstrapCurves(listings);
      writeStoredCurve(key, curve);
      console.log(`[EncarScore] 감가곡선: ${name} ${curve.sampleCount}대 · 그룹 ${curve.groupCount}개 · 1만km당 ${((1 - Math.exp(curve.mileageCoef)) * 100).toFixed(1)}%${curve.bootstrap ? ` · 부트스트랩 ${curve.bootstrap.length}회` : ''}`);
      return { curve, reason: null };
    })();

    curveCache.set(name, promise);
    promise.catch(() => curveCache.delete(name));
    return promise;
  }

  return {
    AGE_EDGES,
    ageSegments,
    curveLogValue,
    parseListing,
    fitCurve,
    insufficiencyReason,
    bootstrapCurves,
    rateLevel,
    estimate,
    fitLevelToPoints,
    fetchCurve
  };
})();
