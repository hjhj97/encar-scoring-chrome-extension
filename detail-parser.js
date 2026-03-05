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
 */

const DetailParser = (() => {

  const BASE = 'https://api.encar.com/v1/readside';

  /**
   * 차량 상세 데이터 전체 취합
   */
  async function fetchDetailData(carId) {
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

      // 2. 보험/사고/렌트 이력 & 3. 성능점검 & 4. 엔카진단 & 5. 옵션가격 — 병렬 요청
      const [recordData, inspectionData, diagnosisData, optionList] = await Promise.all([
        (vehicleNo && recordViewable)
          ? fetchJson(`${BASE}/record/vehicle/${actualId}/open?vehicleNo=${encodeURIComponent(vehicleNo)}`)
          : null,
        fetchJson(`${BASE}/inspection/vehicle/${actualId}`),
        fetchJson(`${BASE}/diagnosis/vehicle/${actualId}`),
        fetchJson(`https://api.encar.com/v1/readside/vehicles/car/${actualId}/options/choice`)
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

      // yearMonth: "202205" → year: 22 (2자리)
      const yearMonth = vehicleData?.category?.yearMonth ?? '';
      const year = yearMonth.length >= 4 ? parseInt(yearMonth.slice(2, 4), 10) : 0;

      return {
        originPrice,
        year,       // API 기반 연식 (DOM 파싱보다 신뢰도 높음)
        mileage: vehicleData?.spec?.mileage ?? 0,   // API 기반 주행거리
        price: vehicleData?.advertisement?.price ?? 0, // API 기반 가격
        ...parseRecord(recordData, !recordViewable),
        ...parseInspection(inspectionData),
        ...parseDiagnosis(diagnosisData)
      };

    } catch (err) {
      console.warn('[EncarScore] fetchDetailData 실패:', carId, err);
      return getDefaultDetailData();
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
    const ownerChangeCount = data.ownerChangeCnt     ?? 0;  // 소유주 변경 횟수

    // 용도 변경/렌트 이력
    const useHistory = data.carInfoUse1s ?? [];
    const hasRentalHistory = useHistory.some(code => code === '3' || code === '4');
    const hasUsageChange = useHistory.length > 1;

    console.log('[EncarScore] 보험이력:', isInsurancePrivate ? '비공개 (큰 감점)' : `${insuranceCount}건`, '/ 내차피해:', myDamageCount, '회 / 렌트이력:', hasRentalHistory, '/ 소유주변경:', ownerChangeCount, '회');

    return { insuranceCount, myDamageCount, myDamageAmount, otherDamageCount, otherDamageAmount, isAccidentFree, isInsurancePrivate, ownerChangeCount, hasRentalHistory, hasUsageChange };
  }

  /* ──────────────────────────────────────────────
   * Inspection API 파싱 (성능점검)
   * 응답 예시:
   *   outers: [{partName:"전 펜더(우)", status:"X"}, ...]
   *     status: "X" = 교환, "/" = 판금/용접, "C" = 부식·손상
   *   simpleRepair: true/false
   * ────────────────────────────────────────────── */
  function parseInspection(data) {
    if (!data) return { hasInspection: false, hasReplacement: false, hasWelding: false, hasCorrosion: false };

    const hasInspection = true;
    // 성능점검 표: outers 배열에서 status 코드 파싱
    // X=교환, /=판금/용접, C/U=부식
    const outers = data.outers ?? [];
    const hasReplacement = outers.some(p => p.statusTypes?.some(st => st.code === 'X') || p.status === 'X');
    const hasWelding     = outers.some(p => p.statusTypes?.some(st => st.code === '/' || st.code === 'W') || p.status === '/' || p.status === 'W');
    const hasCorrosion   = outers.some(p => p.statusTypes?.some(st => st.code === 'C' || st.code === 'U') || p.status === 'C' || p.status === 'U');

    console.log('[EncarScore] 성능점검 → 교환:', hasReplacement, '판금:', hasWelding, '부식:', hasCorrosion);
    return { hasInspection, hasReplacement, hasWelding, hasCorrosion };
  }

  /* ──────────────────────────────────────────────
   * 엔카진단 API 파싱
   * items[].name 으로 프레임 vs 외부패널 구분
   * 외부패널: DOOR, HOOD, FENDER, TRUNK_LID
   * 프레임: 그 외 (PILLAR, SIDE_PANEL, WHEEL_HOUSE 등)
   * resultCode: "REPLACEMENT" = 교환, "NORMAL" = 정상
   * ────────────────────────────────────────────── */
  function parseDiagnosis(data) {
    const defaultResult = { hasDiagnosis: false, diagFrameReplacement: false, diagPanelReplacement: false };
    if (!data || !Array.isArray(data.items) || data.items.length === 0) return defaultResult;

    const hasDiagnosis = true;

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

    console.log('[EncarScore] 엔카진단 → 프레임교환:', diagFrameReplacement, '패널교환:', diagPanelReplacement);
    return { hasDiagnosis, diagFrameReplacement, diagPanelReplacement };
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
      hasRentalHistory: false, hasUsageChange: false
    };
  }

  return { fetchDetailData, getDefaultDetailData };
})();
