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
 */

const DetailParser = (() => {

  const BASE = 'https://api.encar.com/v1/readside';

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
   * withMarketPrices=false 시 시세 조회 생략 (딜러 매물 일괄 처리 시 사용).
   */
  async function fetchCarData(carId, { withMarketPrices = true } = {}) {
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

      // 2. 보험/사고/렌트 이력 & 3. 성능점검 & 4. 엔카진단 & 5. 옵션가격 & 6. 동급매물 시세 & 7. 딜러프로필 — 병렬 요청
      const [recordData, inspectionData, diagnosisData, optionList, marketPriceData, dealerProfileData] = await Promise.all([
        (vehicleNo && recordViewable)
          ? fetchJson(`${BASE}/record/vehicle/${actualId}/open?vehicleNo=${encodeURIComponent(vehicleNo)}`)
          : null,
        fetchJson(`${BASE}/inspection/vehicle/${actualId}`),
        fetchJson(`${BASE}/diagnosis/vehicle/${actualId}`),
        fetchJson(`https://api.encar.com/v1/readside/vehicles/car/${actualId}/options/choice`),
        withMarketPrices ? fetchMarketPrices(vehicleData) : null,
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

    return { insuranceCount, myDamageCount, myDamageAmount, otherDamageCount, otherDamageAmount, isAccidentFree, isInsurancePrivate, accidentAmounts, hasUnavailablePeriod, unavailablePeriods, ownerChangeCount, hasRentalHistory, hasUsageChange };
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
      const formYear        = vehicleData?.category?.formYear;
      const gradeName       = vehicleData?.category?.gradeName;       // e.g., "2.5"
      const gradeDetailName = vehicleData?.category?.gradeDetailName; // e.g., "캘리그래피"
      const currentMileage  = vehicleData?.spec?.mileage ?? 0;

      if (!modelGroup || !formYear) return null;

      // Year.range 형식 사용 (FormYear 필터는 API에서 지원하지 않음)
      const yearStart = `${formYear}00`;
      const yearEnd   = `${formYear}99`;
      const q = `(And.Hidden.N._.ModelGroup.${encodeURIComponent(modelGroup)}._.Year.range(${yearStart}..${yearEnd}).)`;
      // 트림/주행거리 클라이언트 필터링을 위해 충분한 결과 수집
      const url = `https://api.encar.com/search/car/list/general?q=${q}&sr=%7CModifiedDate%7C0%7C100&count=true`;

      const data = await fetchJson(url);
      if (!data?.SearchResults?.length) return null;

      const allValid = data.SearchResults.filter(r =>
        typeof r.Price === 'number' && r.Price > 0 && r.Price < 9999
      );

      // --- 같은 트림 필터 (Badge + BadgeDetail) ---
      const trimFiltered = (gradeName && gradeDetailName)
        ? allValid.filter(r => r.Badge === gradeName && r.BadgeDetail === gradeDetailName)
        : (gradeName ? allValid.filter(r => r.Badge === gradeName) : allValid);

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

      // 우선순위 fallback
      let candidates = mileageFilter(trimFiltered, 0.4);           // 트림 + ±40%
      if (candidates.length < 5) candidates = mileageFilter(trimFiltered, 0.6); // 트림 + ±60%
      if (candidates.length < 5) candidates = trimFiltered;                     // 트림만
      if (candidates.length < 5) candidates = mileageFilter(allValid, 0.4);    // 전체 + ±40%
      if (candidates.length < 3) candidates = allValid;                         // 전체 fallback

      const prices = candidates.map(r => r.Price).sort((a, b) => a - b);
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
        p75: prices[Math.floor(prices.length * 0.75)]
      };

      const trimInfo = [gradeName, gradeDetailName].filter(Boolean).join(' ');
      const mileageInfo = currentMileage > 0 ? ` / 주행 ${Math.round(currentMileage / 1000)}천km 기준` : '';
      console.log(`[EncarScore] 동급매물 시세: ${modelGroup} ${formYear}년식 ${trimInfo}${mileageInfo}, ${candidates.length}대, 중앙값 ${median}만원 (${result.p25}~${result.p75})`);
      return result;
    } catch (err) {
      console.warn('[EncarScore] 시세 조회 실패:', err);
      return null;
    }
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
        candidates.map(r => fetchCarData(r.Id, { withMarketPrices: false }))
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
      dealerAvgScore: null,
      dealerName: '',
      dealerFirmName: '',
      dealerJoinedDatetime: null,
      dealerTotalSales: 0
    };
  }

  return { fetchDetailData, getDefaultDetailData };
})();
