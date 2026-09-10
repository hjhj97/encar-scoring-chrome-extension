/**
 * 엔카 차량 상세 데이터 파서
 *
 * 사용하는 API:
 *  1) https://api.encar.com/v1/readside/vehicle/{id}
 *     → vehicleNo, spec 등 기본 정보
 *  2) https://api.encar.com/v1/readside/record/vehicle/{id}/open?vehicleNo={vehicleNo}
 *     → 보험이력 건수, 사고이력(내차피해/타차가해), 용도변경(렌트) 이력
 *  3) https://api.encar.com/v1/readside/inspection/vehicle/{id}
 *     → 성능점검 결과 (교환·판금·부식)
 *  4) https://api.encar.com/search/car/list/general
 *     → 동급매물 시세 (모델그룹+연식 기준, 같은 트림+비슷한 주행거리로 클라이언트 필터)
 *  5) https://api.encar.com/search/car/list/general?q=UserId
 *     → 판매자(딜러)의 최근 매물 목록 → 동일한 calculateScore로 평균점수 산정
 *  6) https://www.encar.com/dc/dc_carsearchpop.do?method=soldoutCars
 *     → 같은 실제 등록연도·모델·트림의 판매완료 당시 광고가격
 */

const DetailParser = (() => {

  const BASE = 'https://api.encar.com/v1/readside';
  const SCORE_FETCH_CONCURRENCY = 4;
  const scoreCarDataCache = new Map();
  const scoreFetchQueue = [];
  const yearlyMarketDataCache = new Map();
  const soldOutPriceDataCache = new Map();
  let activeScoreFetches = 0;

  /**
   * BMW 계열 등급명에서 가격 성격을 결정하는 파워트레인 코드를 추출한다.
   * 예: xDrive 30e M 스포츠 / xDrive 30e xLine → 모두 "30e"
   */
  function getPowertrainCluster(badge, badgeDetail = '') {
    const text = `${badge || ''} ${badgeDetail || ''}`.trim();
    const match = text.match(/(?:^|\s)(?:xDrive|sDrive)?\s*M?(\d{2,3}(?:e|d|i))(?=\s|$)/i);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * 엔카 검색 DSL은 마침표를 필드/값 구분자로 사용한다.
   * encodeURIComponent도 마침표는 인코딩하지 않으므로 "3.0 TFSI" 같은 값을
   * 쿼리에 직접 넣으면 400이 발생한다. 이런 값은 서버 조건에서 제외하고
   * 응답을 받은 뒤 정확한 Badge/BadgeDetail 값으로 필터링한다.
   */
  function isSearchDslValueSafe(value) {
    return value != null && !String(value).includes('.');
  }

  /**
   * 시세/딜러 점수용 상세 데이터 조회 큐.
   * 여러 카드가 같은 매물을 참조할 때는 Promise까지 공유하고,
   * 엔카 API에 동시에 보내는 상세 조회는 최대 4개로 제한한다.
   */
  function drainScoreFetchQueue() {
    while (activeScoreFetches < SCORE_FETCH_CONCURRENCY && scoreFetchQueue.length > 0) {
      const { carId, resolve } = scoreFetchQueue.shift();
      activeScoreFetches++;

      // 가격 히스토그램 전체는 생략하지만 새 가격 배점에 필요한 연식 평균표는 조회한다.
      // 같은 모델·트림은 yearlyMarketDataCache에서 Promise를 공유한다.
      fetchCarData(carId, { withMarketPrices: false, withYearlyMarketData: true })
        .then(resolve)
        .catch((err) => {
          console.warn('[EncarScore] 비교 매물 상세 조회 실패:', carId, err);
          resolve(null);
        })
        .finally(() => {
          activeScoreFetches--;
          drainScoreFetchQueue();
        });
    }
  }

  function fetchScoreCarData(carId, { priority = false } = {}) {
    const key = String(carId);
    if (scoreCarDataCache.has(key)) return scoreCarDataCache.get(key);

    const promise = new Promise((resolve) => {
      const task = { carId, resolve };
      // 현재 카드의 기본 점수에 필요한 딜러 조회가 시세 평균 계산 뒤에서 대기하지 않게 한다.
      if (priority) scoreFetchQueue.unshift(task);
      else scoreFetchQueue.push(task);
      drainScoreFetchQueue();
    });
    scoreCarDataCache.set(key, promise);
    return promise;
  }

  /**
   * 차량 상세 데이터 전체 취합 (공개 API)
   * = fetchCarData + fetchDealerAvgScore
   */
  async function fetchDetailData(carId) {
    try {
      const base = await fetchCarData(carId, { withMarketPrices: true });
      if (!base) return getDefaultDetailData();

      const dealerAvgScore = await fetchDealerAvgScore(base._userId, carId);
      const { _userId, ...result } = base;
      return { ...result, dealerAvgScore };
    } catch (err) {
      console.warn('[EncarScore] fetchDetailData 실패:', carId, err);
      return getDefaultDetailData();
    }
  }

  /**
   * 차량 핵심 데이터 취합 (내부 함수)
   * 딜러 평균점수 조회는 포함하지 않아 재귀 방지.
   * withMarketPrices=false 시 가격 히스토그램 조회를 생략한다.
   * withYearlyMarketData=true이면 가격 배점용 연식 평균표만 별도로 조회한다.
   */
  async function fetchCarData(carId, {
    withMarketPrices = true,
    withYearlyMarketData = withMarketPrices
  } = {}) {
    try {
      // 1. 기본 정보 (vehicleNo + 보험이력 노출 여부 확인)
      const vehicleData = await fetchJson(`${BASE}/vehicle/${carId}`);
      const vehicleNo = vehicleData?.vehicleNo ?? '';

      // dummy(재등록) 매물은 URL의 carId와 실제 데이터 vehicleId가 다름
      // 모든 하위 API 호출은 실제 vehicleId를 사용해야 함
      const actualId = vehicleData?.vehicleId ?? carId;
      if (actualId !== carId) {
        console.log(`[EncarScore] Dummy 매물 감지: URL=${carId}, 실제 vehicleId=${actualId}`);
      }

      // condition.accident.recordView === false → 보험이력 비공개
      // 이 경우 record API자체가 404를 반환하므로 호출 없이 비공개로 처리
      const recordViewable = vehicleData?.condition?.accident?.recordView !== false;

      // 판매자 정보 추출 (_userId는 내부 전달용, fetchDetailData에서 제거됨)
      const _userId        = vehicleData?.contact?.userId ?? '';
      const dealerName     = vehicleData?.partnership?.dealer?.name ?? '';
      const dealerFirmName = vehicleData?.partnership?.dealer?.firm?.name ?? '';

      // 2. 보험/사고/렌트 이력 & 3. 성능점검 & 4. 엔카진단 & 5. 옵션가격
      // 6. 동급매물 시세 & 7. 연식별 시세 & 8. 딜러프로필 — 병렬 요청
      const [recordData, inspectionData, diagnosisData, optionList, marketPriceData, yearlyMarketData, dealerProfileData] = await Promise.all([
        (vehicleNo && recordViewable)
          ? fetchJson(`${BASE}/record/vehicle/${actualId}/open?vehicleNo=${encodeURIComponent(vehicleNo)}`)
          : null,
        fetchJson(`${BASE}/inspection/vehicle/${actualId}`),
        fetchJson(`${BASE}/diagnosis/vehicle/${actualId}`),
        fetchJson(`https://api.encar.com/v1/readside/vehicles/car/${actualId}/options/choice`),
        withMarketPrices ? fetchMarketPrices(vehicleData) : null,
        withYearlyMarketData ? fetchYearlyMarketData(vehicleData) : null,
        (withMarketPrices && _userId) ? fetchJson(`${BASE}/user/${_userId}`) : null
      ]);

      // originPrice = 기본가 + 실제 선택된 옵션가감의 합계
      const basePrice      = vehicleData?.category?.originPrice ?? 0;
      const selectedCodes  = new Set(vehicleData?.options?.choice ?? []);
      const optionTotal    = Array.isArray(optionList)
        ? optionList
            .filter(o => selectedCodes.has(o.optionCd))
            .reduce((sum, o) => sum + (o.price ?? 0), 0)
        : 0;
      const originPrice = basePrice + optionTotal;
      console.log(`[EncarScore] 신차가: 기본 ${basePrice} + 옵션 ${optionTotal} = ${originPrice}만원`);

      // yearMonth: "202205" → year: 22 (2자리), month: 5
      const yearMonth = vehicleData?.category?.yearMonth ?? '';
      const year  = yearMonth.length >= 4 ? parseInt(yearMonth.slice(2, 4), 10) : 0;
      const month = yearMonth.length >= 6 ? parseInt(yearMonth.slice(4, 6), 10) : 0;
      const powertrainCluster = getPowertrainCluster(
        vehicleData?.category?.gradeName,
        vehicleData?.category?.gradeDetailName
      );

      // 성능점검 비공개 여부: formats 배열이 비어있으면 비공개
      const isInspectionPrivate = (vehicleData?.condition?.inspection?.formats ?? []).length === 0;
      console.log('[EncarScore] 성능점검 비공개:', isInspectionPrivate);

      // 매물 등록 시각 (재등록 포함 현재 매물 기준)
      const firstAdvertisedDateTime = vehicleData?.manage?.firstAdvertisedDateTime ?? null;

      // 딜러 프로필 정보 파싱
      const dealerJoinedDatetime = dealerProfileData?.joinedDatetime ?? null;
      const dealerTotalSales     = dealerProfileData?.salesStatus?.totalSales ?? 0;

      return {
        _userId,
        actualCarId: actualId,
        soldOutCarType: vehicleData?.category?.domestic === true ? 'kor' : 'for',
        powertrainCluster,
        originPrice,
        manufacturerName: vehicleData?.category?.manufacturerName ?? '',
        modelName: vehicleData?.category?.modelName ?? '',
        gradeName: vehicleData?.category?.gradeName ?? '',
        year,       // API 기반 연식 (DOM 파싱보다 신뢰도 높음)
        month,      // API 기반 출고월 (1~12, 없으면 0)
        mileage: vehicleData?.spec?.mileage ?? 0,   // API 기반 주행거리
        price: vehicleData?.advertisement?.price ?? 0, // API 기반 가격
        firstAdvertisedDateTime,
        ...parseRecord(recordData, !recordViewable),
        ...parseInspection(inspectionData),
        ...parseDiagnosis(diagnosisData, vehicleData),
        isInspectionPrivate,
        marketPriceData,
        yearlyMarketData,
        dealerName,
        dealerFirmName,
        dealerJoinedDatetime,
        dealerTotalSales
      };
    } catch (err) {
      console.warn('[EncarScore] fetchCarData 실패:', carId, err);
      return null;
    }
  }

  /**
   * 같은 실제 등록연도·모델·트림의 최근 1년 판매완료 광고가격 평균.
   * CORS 및 EUC-KR 처리는 background service worker가 담당한다.
   */
  function fetchSoldOutPriceData(carId, referencePrice = 0) {
    const key = String(carId || '');
    if (!/^\d+$/.test(key)) return Promise.resolve(null);
    if (soldOutPriceDataCache.has(key)) return soldOutPriceDataCache.get(key);

    const promise = new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'FETCH_ENCAR_SOLD_OUT_AVERAGE',
        carId: key,
        referencePrice
      }, response => {
        if (chrome.runtime.lastError) {
          console.warn('[EncarScore] 판매완료 평균가 메시지 오류:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response?.ok ? response.data : null);
      });
    });

    soldOutPriceDataCache.set(key, promise);
    promise.then(data => {
      if (!data) soldOutPriceDataCache.delete(key);
    });
    return promise;
  }

  /** 여러 등록연도의 최근 1년 판매완료 평균가를 한 번에 조회한다. */
  function fetchSoldOutYearlyData(carId, yearReferences, {
    carType = 'for',
    broadenTrim = false
  } = {}) {
    const id = String(carId || '');
    if (!/^\d+$/.test(id) || !Array.isArray(yearReferences) || yearReferences.length === 0) {
      return Promise.resolve(null);
    }

    const normalizedReferences = yearReferences
      .map(item => ({ year: Number(item?.year), referencePrice: Number(item?.referencePrice) || 0 }))
      .filter(item => Number.isInteger(item.year));
    const cacheKey = [
      'yearly',
      id,
      carType,
      broadenTrim ? 'cluster' : 'exact',
      ...normalizedReferences.map(item => `${item.year}:${item.referencePrice}`)
    ].join(':');
    if (soldOutPriceDataCache.has(cacheKey)) return soldOutPriceDataCache.get(cacheKey);

    const promise = new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'FETCH_ENCAR_SOLD_OUT_YEARLY_AVERAGES',
        carId: id,
        carType,
        broadenTrim,
        yearReferences: normalizedReferences
      }, response => {
        if (chrome.runtime.lastError) {
          console.warn('[EncarScore] 연식별 판매완료 평균가 메시지 오류:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response?.ok ? response.data : null);
      });
    });

    soldOutPriceDataCache.set(cacheKey, promise);
    promise.then(data => {
      if (!data) soldOutPriceDataCache.delete(cacheKey);
    });
    return promise;
  }

  /* ──────────────────────────────────────────────
   * Record API 파싱 (보험이력 / 사고이력 / 렌트)
   * 응답 예시:
   *   openData: true/false  ← false면 보험이력 비공개
   *   accidentCnt: 2
   *   myAccidentCnt: 0,  myAccidentCost: 0
   *   otherAccidentCnt: 2, otherAccidentCost: 1075501
   *   carInfoUse1s: ["3", "2"]  ← 용도 코드 이력
   *     "1"=자가용, "2"=비영업용, "3"=영업/렌트, "4"=법인
   * ────────────────────────────────────────────── */
  function parseRecord(data, forcePrivate = false) {
    // vehicle API에서 recordView=false 이거나, API 호출 실패(404 등 - 보험이력조회불가)인 경우 처리
    if (forcePrivate || !data) {
      const isInsurancePrivate = true; // 비공개 또는 조회불가 모두 true로 설정하여 0점(최대 감점) 처리
      console.log(`[EncarScore] 보험이력: ${forcePrivate ? '비공개 (기본값 설정됨)' : '조회불가 (API 데이터 없음)'}`);
      return {
        insuranceCount: 0,
        myDamageCount: 0, myDamageAmount: 0,
        otherDamageCount: 0, otherDamageAmount: 0,
        isAccidentFree: false, // 데이터를 알 수 없으므로 무사고 아님
        isInsurancePrivate,
        ownerChangeCount: 0,
        ownerChanges: [],
        firstRegistrationDate: null,
        insuranceHistory: [],
        hasRentalHistory: false, hasUsageChange: false
      };
    }

    // 보험이력 비공개 여부 (openData === false, 정상 경로에서의 추가 체크)
    const isInsurancePrivate = data.openData === false;

    const insuranceCount   = data.accidentCnt       ?? 0;
    const myDamageCount    = data.myAccidentCnt      ?? 0;
    const myDamageAmount   = data.myAccidentCost     ?? 0;
    const otherDamageCount = data.otherAccidentCnt   ?? 0;
    const otherDamageAmount= data.otherAccidentCost  ?? 0;
    const isAccidentFree   = (myDamageCount + otherDamageCount) === 0;
    const ownerChangeCount = data.ownerChangeCnt     ?? 0;
    const ownerChanges = !isInsurancePrivate && Array.isArray(data.ownerChanges)
      ? data.ownerChanges.filter(date => typeof date === 'string') : [];
    const firstRegistrationDate = !isInsurancePrivate ? data.firstDate ?? null : null;
    const insuranceHistory = !isInsurancePrivate && Array.isArray(data.accidents)
      ? data.accidents.filter(item => item && typeof item.date === 'string').map(item => ({
          date: item.date,
          amount: typeof item.insuranceBenefit === 'number' && Number.isFinite(item.insuranceBenefit) && item.insuranceBenefit >= 0
            ? item.insuranceBenefit : null,
          laborCost: typeof item.laborCost === 'number' && Number.isFinite(item.laborCost) && item.laborCost >= 0
            ? item.laborCost : null
        })) : [];

    // 개별 보험처리 건당 유효금액 = max(보험지급금, 실제수리비합계)
    // 보험지급금이 수리비보다 낮을 수 있으므로 더 큰 값 사용
    const accidentAmounts  = (data.accidents ?? [])
      .map(a => {
        const repair = (a.partCost ?? 0) + (a.laborCost ?? 0) + (a.paintingCost ?? 0);
        return Math.max(a.insuranceBenefit ?? 0, repair);
      })
      .filter(a => a > 0);

    // 용도 변경/렌트 이력
    const useHistory = data.carInfoUse1s ?? [];
    const hasRentalHistory = useHistory.some(code => code === '3' || code === '4');
    const hasUsageChange = useHistory.length > 1;

    // 정보제공 불가능기간 (notJoinDate1~5 중 하나라도 있으면 true)
    const unavailablePeriods = [
      data.notJoinDate1, data.notJoinDate2, data.notJoinDate3,
      data.notJoinDate4, data.notJoinDate5
    ].filter(Boolean);
    const hasUnavailablePeriod = unavailablePeriods.length > 0;

    console.log('[EncarScore] 보험이력:', isInsurancePrivate ? '비공개 (큰 감점)' : `${insuranceCount}건`, '/ 내차피해:', myDamageCount, '회 / 렌트이력:', hasRentalHistory, '/ 소유주변경:', ownerChangeCount, '회 / 정보제공불가기간:', unavailablePeriods);

    return { insuranceCount, myDamageCount, myDamageAmount, otherDamageCount, otherDamageAmount, isAccidentFree, isInsurancePrivate, accidentAmounts, hasUnavailablePeriod, unavailablePeriods, ownerChangeCount, ownerChanges, firstRegistrationDate, insuranceHistory, hasRentalHistory, hasUsageChange };
  }

  /* ──────────────────────────────────────────────
   * Inspection API 파싱 (성능점검)
   * outers[].attributes: RANK_ONE(외판1), RANK_TWO(외판2), RANK_A(골격A), RANK_B(골격B)
   * outers[].statusTypes[].code: X=교환, /|W=판금, C|U=부식
   * ────────────────────────────────────────────── */
  function parseInspection(data) {
    if (!data) return { hasInspection: false, hasReplacement: false, hasWelding: false, hasCorrosion: false, rankCounts: null };

    const hasInspection = true;
    const outers = data.outers ?? [];

    // 랭크별 상태 건수 집계
    const rankCounts = {
      ONE: { X: 0, W: 0, C: 0 },
      TWO: { X: 0, W: 0, C: 0 },
      A:   { X: 0, W: 0, C: 0 },
      B:   { X: 0, W: 0, C: 0 }
    };

    for (const item of outers) {
      const hasX = item.statusTypes?.some(s => s.code === 'X') || item.status === 'X';
      const hasW = item.statusTypes?.some(s => ['/', 'W'].includes(s.code)) || ['/', 'W'].includes(item.status);
      const hasC = item.statusTypes?.some(s => ['C', 'U'].includes(s.code)) || ['C', 'U'].includes(item.status);

      const attrs = item.attributes ?? [];
      const rank = attrs.includes('RANK_B')   ? 'B'
                 : attrs.includes('RANK_A')   ? 'A'
                 : attrs.includes('RANK_TWO') ? 'TWO'
                 : 'ONE';

      if (hasX) rankCounts[rank].X++;
      if (hasW) rankCounts[rank].W++;
      if (hasC) rankCounts[rank].C++;
    }

    const hasReplacement = outers.some(p => p.statusTypes?.some(st => st.code === 'X') || p.status === 'X');
    const hasWelding     = outers.some(p => p.statusTypes?.some(st => ['/', 'W'].includes(st.code)) || ['/', 'W'].includes(p.status));
    const hasCorrosion   = outers.some(p => p.statusTypes?.some(st => ['C', 'U'].includes(st.code)) || ['C', 'U'].includes(p.status));

    console.log('[EncarScore] 성능점검 → 골격A교환:', rankCounts.A.X, '골격B교환:', rankCounts.B.X,
      '외판2교환:', rankCounts.TWO.X, '외판1교환:', rankCounts.ONE.X,
      '판금:', hasWelding, '부식:', hasCorrosion);
    return { hasInspection, hasReplacement, hasWelding, hasCorrosion, rankCounts };
  }

  /* ──────────────────────────────────────────────
   * 엔카진단 API 파싱
   * items[].name 으로 프레임 vs 외부패널 구분
   * 외부패널: DOOR, HOOD, FENDER, TRUNK_LID
   * 프레임: 그 외 (PILLAR, SIDE_PANEL, WHEEL_HOUSE 등)
   * resultCode: "REPLACEMENT" = 교환, "NORMAL" = 정상
   * ────────────────────────────────────────────── */
  function parseDiagnosis(data, vehicleData) {
    const defaultResult = { hasDiagnosis: false, diagnosisTier: null, diagFrameReplacement: false, diagPanelReplacement: false };
    if (!data || !Array.isArray(data.items) || data.items.length === 0) return defaultResult;

    const hasDiagnosis = true;

    // 진단 등급: diag2Partnered=true → '++', preVerified=true → '+', else → '기본'
    const diag2Partnered = vehicleData?.partnership?.diag2Partnered ?? false;
    const preVerified    = vehicleData?.advertisement?.preVerified ?? false;
    const diagnosisTier  = diag2Partnered ? 'PLUSPLUS' : preVerified ? 'PLUS' : 'BASIC';

    // 외부패널 항목 이름 (name 필드)
    const OUTER_PANEL_NAMES = new Set([
      'FRONT_DOOR_LEFT', 'FRONT_DOOR_RIGHT',
      'BACK_DOOR_LEFT',  'BACK_DOOR_RIGHT',
      'HOOD', 'TRUNK_LID',
      'FRONT_FENDER_LEFT', 'FRONT_FENDER_RIGHT',
      'QUARTER_PANEL_LEFT', 'QUARTER_PANEL_RIGHT'
    ]);
    // 코멘트 항목은 판단에서 제외
    const COMMENT_NAMES = new Set(['CHECKER_COMMENT', 'OUTER_PANEL_COMMENT']);

    const replaced = data.items.filter(item => item.resultCode === 'REPLACEMENT');
    const diagPanelReplacement = replaced.some(item => OUTER_PANEL_NAMES.has(item.name));
    const diagFrameReplacement = replaced.some(item => !OUTER_PANEL_NAMES.has(item.name) && !COMMENT_NAMES.has(item.name));

    console.log(`[EncarScore] 엔카진단 ${diagnosisTier} → 프레임교환:`, diagFrameReplacement, '패널교환:', diagPanelReplacement);
    return { hasDiagnosis, diagnosisTier, diagFrameReplacement, diagPanelReplacement };
  }

  /* ──────────────────────────────────────────────
   * 동급매물 시세 조회
   * 같은 트림(Badge+BadgeDetail) + 비슷한 주행거리 기준으로 중앙값/사분위수 계산
   * 우선순위: 트림+주행거리(±40%) → 트림+주행거리(±60%) → 트림만 → 주행거리만(±40%) → 전체
   * ────────────────────────────────────────────── */
  async function fetchMarketPrices(vehicleData) {
    try {
      const modelGroup      = vehicleData?.category?.modelGroupName;
      const modelName       = vehicleData?.category?.modelName;
      const formYear        = vehicleData?.category?.formYear;
      const gradeName       = vehicleData?.category?.gradeName;       // e.g., "2.5"
      const gradeDetailName = vehicleData?.category?.gradeDetailName; // e.g., "캘리그래피"
      const currentMileage  = vehicleData?.spec?.mileage ?? 0;

      if (!modelGroup || !formYear) return null;

      // 현재 차량 연식 기준 ±2년 범위 검색 (연식별 가격 분포 비교)
      const curYear   = parseInt(formYear, 10) || 2020;
      const yearStart = `${curYear - 2}00`;
      const yearEnd   = `${curYear + 2}99`;
      // 정확한 모델 세대와 트림만 조회한다.
      const hasValidDetail = gradeDetailName && !/세부등급\s*없음|없음|^-$|^기타$/i.test(gradeDetailName);
      const targetPowertrain = getPowertrainCluster(gradeName, hasValidDetail ? gradeDetailName : '');
      const canFilterGradeOnServer = !targetPowertrain && gradeName && isSearchDslValueSafe(gradeName);
      const canFilterDetailOnServer = !targetPowertrain && hasValidDetail && isSearchDslValueSafe(gradeDetailName);
      const hasOmittedTrimFilter = !targetPowertrain && (
        (gradeName && !canFilterGradeOnServer) ||
        (hasValidDetail && !canFilterDetailOnServer)
      );
      let q = `(And.Hidden.N._.ModelGroup.${encodeURIComponent(modelGroup)}.`;
      if (modelName) q += `_.Model.${encodeURIComponent(modelName)}.`;
      // 30e처럼 파워트레인 코드가 있으면 M 스포츠/xLine 등 하위 명칭을 함께 모으기 위해
      // Badge 조건은 서버 쿼리에서 빼고 아래 클라이언트 필터에서 코드가 같은지 검사한다.
      // 마침표가 포함된 트림도 검색 DSL을 깨므로 서버 조건에서는 빼고 동일하게 클라이언트에서 검사한다.
      if (canFilterGradeOnServer) q += `_.Badge.${encodeURIComponent(gradeName)}.`;
      if (canFilterDetailOnServer) q += `_.BadgeDetail.${encodeURIComponent(gradeDetailName)}.`;
      q += `_.Year.range(${yearStart}..${yearEnd}).)`;

      const resultLimit = (targetPowertrain || hasOmittedTrimFilter) ? 500 : 100;
      const url = `https://api.encar.com/search/car/list/general?q=${q}&sr=%7CModifiedDate%7C0%7C${resultLimit}&count=true`;
      const data = await fetchJson(url);

      if (!data?.SearchResults?.length) return null;

      // 렌트/리스 승계 매물(인도금만 가격으로 등록된 매물) 및 중복 매물(DUPLICATION) 제외
      const allValid = data.SearchResults.filter(r =>
        typeof r.Price === 'number' &&
        r.Price > 0 &&
        r.Price < 9999 &&
        (!modelName || String(r.Model || '').trim() === String(modelName).trim()) &&
        (!gradeName || targetPowertrain || String(r.Badge || '').trim() === String(gradeName).trim()) &&
        (!hasValidDetail || targetPowertrain || String(r.BadgeDetail || '').trim() === String(gradeDetailName).trim()) &&
        r.SellType !== '렌트' &&
        r.SellType !== '리스' &&
        !r.LeaseType &&
        r.ServiceCopyCar !== 'DUPLICATION'
      );

      // --- 트림 정규화 매칭 및 표준 클러스터링 ---
      // 괄호 안 옵션(장애인용, 렌터카, 드라이브와이즈 등) 및 (세부등급 없음) 더미값 제거하여 동일 트림을 100% 동일 클러스터로 통합
      function getCanonicalTrim(badge, detail) {
        badge = badge || '';
        detail = detail || '';

        // 1. 더미 detail 제거
        if (/세부등급\s*없음|없음|^-$|^기타$/i.test(detail.trim())) {
          detail = '';
        }

        // 2. 괄호 속 옵션 정보 제거 (e.g. (장애인용), (선루프/네비), (렌터카), (드라이브와이즈))
        const badgeClean = badge.replace(/\([^)]*\)|（[^）]*）/g, '').trim();
        const detailClean = detail.replace(/\([^)]*\)|（[^）]*）/g, '').trim();

        let target = detailClean || badgeClean;

        // GT Line 표준화
        target = target.replace(/GT[\s\-_]*Line/gi, 'GT Line');

        // 트림명 추출을 위한 모델/연식/엔진/인승/구동방식 접두사 및 수식어 제거
        const stripPatterns = [
          /^(더\s*뉴|디\s*올\s*뉴|올\s*뉴|더\s*넥스트|신형)\s*/i,
          /^(가솔린|디젤|LPI|LPG|HEV|EV|하이브리드|전기)\s*/i,
          /^\d+\.\d+[T-t]*\s*/i,
          /^(2WD|4WD|AWD|2륜|4륜|xDrive|4MATIC|콰트로|quattro)\s*/i,
          /^(5인승|7인승|9인승|11인승|인승)\s*/i,
          /^(롱레인지|스탠다드)\s*/i,
        ];

        let changed = true;
        while (changed) {
          changed = false;
          for (const pat of stripPatterns) {
            const newT = target.replace(pat, '').trim();
            if (newT !== target && newT) {
              target = newT;
              changed = true;
            }
          }
        }

        // 중간 또는 접미사의 구동방식 옵션 제거 (e.g. '520d xDrive M 스포츠 플러스' -> '520d M 스포츠 플러스')
        target = target.replace(/\s*(2WD|4WD|AWD|2륜|4륜|xDrive|4MATIC|콰트로|quattro)\s*/gi, ' ').trim();
        target = target.replace(/\s+/g, ' ');

        return target || detailClean || badgeClean || '일반';
      }

      function isTrimMatch(rBadge, rBadgeDetail, gName, gDetailName) {
        const targetCluster = getPowertrainCluster(gName, gDetailName);
        if (targetCluster) {
          return getPowertrainCluster(rBadge, rBadgeDetail) === targetCluster;
        }

        const targetTrim = getCanonicalTrim(gName, gDetailName);
        const candidateTrim = getCanonicalTrim(rBadge, rBadgeDetail);
        if (!targetTrim || !candidateTrim) return true;
        return targetTrim.toLowerCase() === candidateTrim.toLowerCase();
      }

      const trimFiltered = (gradeName || gradeDetailName)
        ? allValid.filter(r => isTrimMatch(r.Badge, r.BadgeDetail, gradeName, gradeDetailName))
        : allValid;

      // --- 주행거리 필터 (factor = 허용 오차 비율) ---
      function mileageFilter(arr, factor) {
        if (currentMileage <= 0) return arr;
        const lo = Math.max(0, currentMileage * (1 - factor));
        const hi = currentMileage * (1 + factor);
        return arr.filter(r => {
          if (typeof r.Mileage !== 'number') return true; // 필드 없으면 통과
          return r.Mileage >= lo && r.Mileage <= hi;
        });
      }

      // 주행거리 범위만 단계적으로 넓히고, 다른 트림으로는 확대하지 않는다.
      let candidates = mileageFilter(trimFiltered, 0.4);           // 트림 + ±40%
      if (candidates.length < 5) candidates = mileageFilter(trimFiltered, 0.6); // 트림 + ±60%
      if (candidates.length < 5) candidates = trimFiltered; // 동일 트림 전체

      const items = candidates.map(r => {
        let y = 0;
        if (r.Year) {
          y = parseInt(String(r.Year).slice(0, 4), 10);
        } else if (r.FormYear) {
          y = parseInt(r.FormYear, 10);
        }

        const gradeStr = targetPowertrain || getCanonicalTrim(r.Badge, r.BadgeDetail);

        return {
          id: r.Id,
          price: r.Price,
          year: y,
          mileage: r.Mileage,
          grade: gradeStr
        };
      }).filter(it => it.price > 0);

      const prices = items.map(it => it.price).sort((a, b) => a - b);
      if (prices.length < 3) return null;

      const median = prices.length % 2 === 0
        ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
        : prices[Math.floor(prices.length / 2)];

      const result = {
        median,
        count: prices.length,
        min: prices[0],
        max: prices[prices.length - 1],
        p25: prices[Math.floor(prices.length * 0.25)],
        p75: prices[Math.floor(prices.length * 0.75)],
        prices: prices,
        items: items
      };

      const trimInfo = [gradeName, gradeDetailName].filter(Boolean).join(' ');
      const mileageInfo = currentMileage > 0 ? ` / 주행 ${Math.round(currentMileage / 1000)}천km 기준` : '';
      console.log(`[EncarScore] 동급매물 시세: ${modelGroup} ${formYear}년식(±2년) ${trimInfo}${mileageInfo}, ${items.length}대, 중앙값 ${median}만원 (${result.p25}~${result.p75})`);
      return result;
    } catch (err) {
      console.warn('[EncarScore] 시세 조회 실패:', err);
      return null;
    }
  }

  /* ──────────────────────────────────────────────
   * 연식별 시세 조회
   * 같은 ModelGroup + Model + 파워트레인 트림 클러스터의 판매 중 매물을 조회한 뒤
   * 출고 후 경과 연수별 평균 판매가격과 매물 수를 집계한다.
   * ────────────────────────────────────────────── */
  function fetchYearlyMarketData(vehicleData) {
    const modelGroup = vehicleData?.category?.modelGroupName;
    const modelName = vehicleData?.category?.modelName;
    const gradeName = vehicleData?.category?.gradeName;
    const gradeDetailName = vehicleData?.category?.gradeDetailName;
    const hasValidGradeDetail = gradeDetailName && !/세부등급\s*없음|없음|^-$|^기타$/i.test(gradeDetailName);
    const targetPowertrain = getPowertrainCluster(gradeName, hasValidGradeDetail ? gradeDetailName : '');
    const canFilterGradeOnServer = !targetPowertrain && gradeName && isSearchDslValueSafe(gradeName);
    const canFilterDetailOnServer = !targetPowertrain && hasValidGradeDetail && isSearchDslValueSafe(gradeDetailName);
    const trimCacheKey = targetPowertrain || [gradeName, hasValidGradeDetail ? gradeDetailName : ''].filter(Boolean).join('::');
    if (!modelGroup) return Promise.resolve(null);
    const cacheKey = [modelGroup, modelName, trimCacheKey]
      .filter(Boolean)
      .join('::');
    if (yearlyMarketDataCache.has(cacheKey)) return yearlyMarketDataCache.get(cacheKey);

    const promise = (async () => {
      try {
        // 파워트레인 코드가 있으면 30e M 스포츠/30e M 스포츠 프로처럼 같은 코드의
        // 하위 트림을 함께 수집하고, 실제 클러스터 판정은 응답 데이터에서 다시 수행한다.
        let q = `(And.Hidden.N._.ModelGroup.${encodeURIComponent(modelGroup)}.`;
        if (modelName) q += `_.Model.${encodeURIComponent(modelName)}.`;
        // 마침표가 들어간 트림은 검색 DSL에서 400을 만들기 때문에 서버 조건에서는 제외한다.
        // 아래 validItems 필터가 원래 Badge/BadgeDetail과 정확히 일치하는 매물만 남긴다.
        if (canFilterGradeOnServer) q += `_.Badge.${encodeURIComponent(gradeName)}.`;
        if (canFilterDetailOnServer) q += `_.BadgeDetail.${encodeURIComponent(gradeDetailName)}.`;
        q += ')';
        const url = `https://api.encar.com/search/car/list/general?q=${q}&sr=%7CModifiedDate%7C0%7C500&count=true`;
        const data = await fetchJson(url);
        if (!data?.SearchResults?.length) return null;

        const currentYear = new Date().getFullYear();
        const groups = new Map();
        const validItems = data.SearchResults.filter(item =>
          typeof item.Price === 'number' &&
          item.Price > 0 &&
          item.Price < 9999 &&
          // API 쿼리가 느슨하게 매칭되는 경우에도 다른 세대 모델은 다시 제외한다.
          (!modelName || String(item.Model || '').trim() === String(modelName).trim()) &&
          (!gradeName || (targetPowertrain
            ? getPowertrainCluster(item.Badge, item.BadgeDetail) === targetPowertrain
            : String(item.Badge || '').trim() === String(gradeName).trim())) &&
          (!hasValidGradeDetail || targetPowertrain || String(item.BadgeDetail || '').trim() === String(gradeDetailName).trim()) &&
          item.SellType !== '렌트' &&
          item.SellType !== '리스' &&
          !item.LeaseType &&
          item.ServiceCopyCar !== 'DUPLICATION'
        );

        for (const item of validItems) {
          // 출고 후 경과 연수이므로 모델 형식연도(FormYear)보다 실제 등록연월(Year)을 우선한다.
          const registeredYearMatch = String(item.Year || '').match(/(?:19|20)\d{2}/);
          const formYearMatch = String(item.FormYear || '').match(/(?:19|20)\d{2}/);
          const year = parseInt(registeredYearMatch?.[0] || formYearMatch?.[0] || '0', 10);
          if (year < 1980 || year > currentYear) continue;

          const age = currentYear - year;
          const group = groups.get(age) || { age, year, count: 0, priceTotal: 0 };
          group.count++;
          group.priceTotal += item.Price;
          groups.set(age, group);
        }

        const points = [...groups.values()]
          .sort((a, b) => a.age - b.age)
          .map(group => ({
            age: group.age,
            year: group.year,
            count: group.count,
            avgPrice: Math.round(group.priceTotal / group.count)
          }));

        if (points.length === 0) return null;

        const sourceCount = data.Count ?? data.count ?? data.SearchResults.length;
        const result = {
          modelGroup,
          modelName: modelName || '',
          gradeName: gradeName || '',
          gradeDetailName: hasValidGradeDetail ? gradeDetailName : '',
          trimCluster: targetPowertrain || '',
          points,
          listedCount: points.reduce((sum, point) => sum + point.count, 0),
          sourceCount,
          isSampled: sourceCount > data.SearchResults.length
        };

        const trimInfo = [gradeName, hasValidGradeDetail ? gradeDetailName : ''].filter(Boolean).join(' ');
        console.log(`[EncarScore] 연식별 시세: ${modelName || modelGroup} ${trimInfo}, ${points.length}개 연식, ${result.listedCount}대 집계`);
        return result;
      } catch (err) {
        console.warn('[EncarScore] 연식별 시세 조회 실패:', err);
        return null;
      }
    })();

    yearlyMarketDataCache.set(cacheKey, promise);
    return promise;
  }

  /**
   * 동급 시세 매물에 현재 사용자의 채점 기준으로 계산한 점수를 붙인다.
   * 검색 API만으로는 보험/점검/렌트 이력을 알 수 없어 상세 데이터를 조회한다.
   */
  async function scoreMarketItems(marketPriceData, weights = DEFAULT_WEIGHTS, config = {}, currentCar = null) {
    const items = marketPriceData?.items;
    if (!Array.isArray(items) || items.length === 0) return marketPriceData;

    const scoredItems = await Promise.all(items.map(async (item) => {
      if (Number.isFinite(item.score)) return item;

      if (currentCar && String(item.id) === String(currentCar.carId) && Number.isFinite(currentCar.score)) {
        return { ...item, score: currentCar.score };
      }

      if (!item.id) return item;
      const carData = await fetchScoreCarData(item.id);
      if (!carData) return item;

      const { _userId, ...scoreData } = carData;
      const scoreResult = EncarScoring.calculateScore({
        ...scoreData,
        // 모든 후보도 현재 차량과 동일한 연식별 평균가격 표로 가격점수를 계산한다.
        yearlyMarketData: currentCar?.yearlyMarketData ?? scoreData.yearlyMarketData ?? null,
        marketPriceData
      }, weights, config);

      return { ...item, score: scoreResult.total };
    }));

    return {
      ...marketPriceData,
      items: scoredItems,
      scoresLoaded: true,
      scoredCount: scoredItems.filter(item => Number.isFinite(item.score)).length
    };
  }

  /* ──────────────────────────────────────────────
   * 딜러(판매자)의 최근 매물 10개 평균점수 조회
   * fetchCarData (시세 제외)로 실제 사고/점검/렌트 데이터를 취합한 뒤
   * calculateScore를 동일하게 적용
   * ────────────────────────────────────────────── */
  async function fetchDealerAvgScore(userId, excludeId) {
    if (!userId) return null;
    try {
      const q = `(And.Hidden.N._.UserId.${encodeURIComponent(userId)}.)`;
      const searchData = await fetchJson(
        `https://api.encar.com/search/car/list/general?count=true&q=${q}&sr=%7CModifiedDate%7C0%7C11`
      );
      if (!searchData?.SearchResults?.length) return null;

      const candidates = searchData.SearchResults
        .filter(r => String(r.Id) !== String(excludeId))
        .slice(0, 10);
      if (candidates.length === 0) return null;

      // 각 매물의 실제 상세 데이터 병렬 취합 (시세 조회 제외로 API 부하 최소화)
      const carDataList = await Promise.allSettled(
        candidates.map(r => fetchScoreCarData(r.Id, { priority: true }))
      );

      const scores = [];
      for (const settled of carDataList) {
        if (settled.status !== 'fulfilled' || !settled.value) continue;
        const { _userId, ...carData } = settled.value;
        const result = EncarScoring.calculateScore(carData, DEFAULT_WEIGHTS);
        scores.push(result.total);
      }

      if (scores.length === 0) return null;
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      console.log(`[EncarScore] 딜러(${userId}) 최근 ${scores.length}개 평균: ${avg}점`);
      return { avg, count: scores.length };
    } catch (err) {
      console.warn('[EncarScore] 딜러 평균점수 조회 실패:', err);
      return null;
    }
  }

  /* ──────────────────────────────────────────────
   * 공통 fetch helper
   * ────────────────────────────────────────────── */
  async function fetchJson(url) {
    const res = await fetch(url, {
      credentials: 'omit',
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      console.warn('[EncarScore] API 오류:', url, res.status);
      return null;
    }
    return res.json();
  }

  /** 기본값 (API 실패 시) */
  function getDefaultDetailData() {
    return {
      actualCarId: null,
      soldOutCarType: 'for',
      powertrainCluster: null,
      insuranceCount: 0,
      myDamageCount: 0, myDamageAmount: 0,
      otherDamageCount: 0, otherDamageAmount: 0,
      isAccidentFree: false,
      hasInspection: false,
      hasReplacement: false, hasWelding: false, hasCorrosion: false,
      hasRentalHistory: false, hasUsageChange: false,
      month: 0,
      firstAdvertisedDateTime: null,
      marketPriceData: null,
      yearlyMarketData: null,
      dealerAvgScore: null,
      dealerName: '',
      dealerFirmName: '',
      dealerJoinedDatetime: null,
      dealerTotalSales: 0
    };
  }

  return {
    fetchDetailData,
    fetchSoldOutPriceData,
    fetchSoldOutYearlyData,
    scoreMarketItems,
    getDefaultDetailData
  };
})();
