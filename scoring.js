/**
 * 엔카 중고차 품질 점수 계산 모듈
 * 100점 만점, S/A/B/C/D 등급
 */

const EncarScoring = (() => {
  // DEFAULT_WEIGHTS는 constants.js에서 전역으로 로드됨

  /**
   * 사고/보험이력 통합 점수 (accident 만점)
   *
   * 보험금 합계(내차 + 타차)를 신차가 대비 비율로 판단:
   *   - 비공개: 0점 (최대 감점)
   *   - 무사고: 만점
   *   - 보험금 합계 < 신차가 10%: 경미한 사고, 작은 감점
   *   - 10~20%: 중간 감점
   *   - 20% 초과: 심각한 손상, 큰 감점
   *
   * originPrice가 없는 경우 보험금 절대 금액으로 판단
   */
  // 정보제공 불가능기간 총 개월 수 계산 ("202201~202512" 형식)
  function calcUnavailableMonths(periods) {
    let total = 0;
    for (const p of periods) {
      const m = p.match(/(\d{6})~(\d{6})/);
      if (!m) continue;
      const sy = parseInt(m[1].slice(0, 4)), sm = parseInt(m[1].slice(4, 6));
      const ey = parseInt(m[2].slice(0, 4)), em = parseInt(m[2].slice(4, 6));
      total += (ey - sy) * 12 + (em - sm) + 1;
    }
    return total;
  }

  function scoreAccident(data, maxPoints) {
    const {
      isInsurancePrivate = false,
      originPrice        = 0,
      accidentAmounts    = [],  // 개별 건당 insuranceBenefit
      hasUnavailablePeriod = false,
      unavailablePeriods   = []
    } = data;

    if (isInsurancePrivate) return 0; // 보험이력 비공개 → 0점

    // 기본 사고 점수: 가장 큰 단일 건 기준 (보험지급금 vs 실제수리비 중 큰 값)
    let baseScore;
    if (accidentAmounts.length === 0) {
      baseScore = maxPoints; // 무사고
    } else if (originPrice > 0) {
      const originWon      = originPrice * 10000;
      const maxSingleRatio = Math.max(...accidentAmounts) / originWon;

      if (maxSingleRatio <= 0.08) baseScore = maxPoints * 0.75; // 8% 이하: 경미
      else if (maxSingleRatio <= 0.15) baseScore = maxPoints * 0.45; // 8~15%: 중간
      else baseScore = maxPoints * 0.1;                               // 15% 초과: 심각
    } else {
      // originPrice 없는 경우 최대 단일 건 절대 금액 기준
      const maxSingle = Math.max(...accidentAmounts);
      if (maxSingle < 500000)       baseScore = maxPoints * 0.85;
      else if (maxSingle < 2000000) baseScore = maxPoints * 0.6;
      else if (maxSingle < 5000000) baseScore = maxPoints * 0.35;
      else baseScore = maxPoints * 0.1;
    }

    // 다중 사고 추가 감점 (사고 건수가 많을수록 추가 감점)
    if (accidentAmounts.length >= 4) baseScore = Math.max(0, baseScore - 5);
    else if (accidentAmounts.length >= 2) baseScore = Math.max(0, baseScore - 2);

    // 정보제공 불가능기간 패널티 (1개월 이하 패널티 없음, 6개월 이하 -10점, 초과 -20점)
    if (hasUnavailablePeriod) {
      const months  = calcUnavailableMonths(unavailablePeriods);
      const penalty = months <= 1 ? 0 : months <= 6 ? 10 : 20;
      baseScore = Math.max(0, baseScore - penalty);
    }

    return baseScore;
  }

  /**
   * 주행거리 점수 (mileage 만점)
   */
  function scoreMileage(data, maxPoints) {
    const { mileage = 0, year = 0, month = 0 } = data;
    if (!year || !mileage) return maxPoints * 0.5;

    const now = new Date();
    const nowYear = now.getFullYear(), nowMonth = now.getMonth() + 1;
    const ageMonths = (month > 0)
      ? Math.max(1, (nowYear - (2000 + year)) * 12 + (nowMonth - month))
      : Math.max(12, (nowYear - (2000 + year)) * 12);
    const avgAnnualKm = mileage / ageMonths * 12;

    if (avgAnnualKm <= 10000) return maxPoints;
    if (avgAnnualKm <= 15000) return maxPoints * 0.9;
    if (avgAnnualKm <= 20000) return maxPoints * 0.7;
    if (avgAnnualKm <= 30000) return maxPoints * 0.5;
    if (avgAnnualKm <= 40000) return maxPoints * 0.3;
    return maxPoints * 0.1;
  }

  /**
   * 가격비율 → 점수 변환 헬퍼
   * ratio = 실제가 / 기준가 → 낮을수록 저렴 → 높은 점수
   */
  function ratioToScore(priceRatio, maxPoints) {
    if (priceRatio <= 0.85) return maxPoints;
    if (priceRatio <= 0.95) return maxPoints * 0.9;
    if (priceRatio <= 1.00) return maxPoints * 0.8;
    if (priceRatio <= 1.05) return maxPoints * 0.7;
    if (priceRatio <= 1.10) return maxPoints * 0.6;
    if (priceRatio <= 1.15) return maxPoints * 0.5;
    if (priceRatio <= 1.25) return maxPoints * 0.35;
    if (priceRatio <= 1.35) return maxPoints * 0.2;
    return maxPoints * 0.1;
  }

  /**
   * 가격 점수 (price 만점)
   *
   * 동급매물 5대 이상 확보 시: 시세 중앙값 대비 비율로 산정
   * 5대 미만(데이터 부족) 시: 신차가 대비 감가율로 산정
   */
  function scorePrice(data, maxPoints, config = {}) {
    const { price = 0, year = 0, originPrice = 0, marketPriceData = null } = data;

    // ── 절대가격 모드 (가격우선 프리셋) ──
    if (config.priceMode === 'absolute') {
      if (!price) return maxPoints * 0.5;
      if (price <= 1000) return maxPoints;
      if (price <= 1500) return maxPoints * 0.9;
      if (price <= 2000) return maxPoints * 0.8;
      if (price <= 2500) return maxPoints * 0.7;
      if (price <= 3000) return maxPoints * 0.6;
      if (price <= 4000) return maxPoints * 0.45;
      if (price <= 5000) return maxPoints * 0.3;
      if (price <= 7000) return maxPoints * 0.2;
      return maxPoints * 0.1;
    }

    // ── 상대가격 모드 (기본) ──
    if (!price) return maxPoints * 0.5;

    // A) 동급매물 시세 기반 (5대 이상 데이터 확보 시 우선 사용)
    if (marketPriceData && marketPriceData.median > 0 && marketPriceData.count >= 5) {
      return ratioToScore(price / marketPriceData.median, maxPoints);
    }

    // B) 신차가 대비 감가율 (시세 데이터 부족 시 fallback)
    if (originPrice > 0 && year > 0) {
      const currentYear = new Date().getFullYear();
      const carAge = Math.max(1, currentYear - (2000 + year));
      const RETENTION = [1.0, 0.85, 0.75, 0.66, 0.58, 0.52, 0.46, 0.41, 0.37, 0.33, 0.30];
      const expectedPrice = originPrice * RETENTION[Math.min(carAge, 10)];
      return ratioToScore(price / expectedPrice, maxPoints);
    }

    return maxPoints * 0.5;
  }

  /**
   * 성능점검 점수 (inspection 만점)
   *
   * [엔카진단]
   *   - 프레임 교환: 큰 감점 (-12점)
   *   - 외부패널 교환: 작은 감점 (-3점)
   *
   * [일반 성능점검표 - 랭크별 패널티]
   *   골격 B랭크(대쉬·필러·사이드멤버): 교환 -15, 판금 -12 (per item)
   *   골격 A랭크(리어패널·트렁크플로어 등): 교환 -10, 판금 -8
   *   외판 2랭크(쿼터·펜더·루프): 교환 -4, 판금 -3
   *   외판 1랭크(도어·트렁크리드·후드): 교환 -1, 판금 -2
   *   부식: -2 per item (랭크 무관)
   */
  function scoreInspection(data, maxPoints) {
    if (data.isInspectionPrivate) return 0; // 성능점검 비공개 → 0점

    let score = maxPoints;
    const {
      hasInspection = false, hasReplacement = false, hasWelding = false, hasCorrosion = false,
      hasDiagnosis  = false, diagFrameReplacement = false, diagPanelReplacement = false,
      rankCounts    = null
    } = data;

    if (hasDiagnosis) {
      if (diagFrameReplacement) score -= 12;
      if (diagPanelReplacement) score -= 3;
      return Math.max(0, score);
    }

    if (!hasInspection) return maxPoints * 0.5;

    if (rankCounts) {
      // 골격 B랭크: 대쉬패널, 필러(A/B/C), 프론트/리어 사이드멤버 등 — 최고 심각
      score -= rankCounts.B.X * 15;
      score -= rankCounts.B.W * 12;
      // 골격 A랭크: 리어패널, 트렁크플로어, 인사이드패널 등 — 심각한 구조적 손상
      score -= rankCounts.A.X * 10;
      score -= rankCounts.A.W * 8;
      // 외판 2랭크: 쿼터패널, 프론트펜더, 루프패널 등
      score -= rankCounts.TWO.X * 4;
      score -= rankCounts.TWO.W * 3;
      // 외판 1랭크: 도어, 트렁크리드, 후드 등 — 경미
      score -= rankCounts.ONE.X * 1;
      score -= rankCounts.ONE.W * 2;
      // 부식 (랭크 무관)
      const totalCorrosion = rankCounts.ONE.C + rankCounts.TWO.C + rankCounts.A.C + rankCounts.B.C;
      score -= totalCorrosion * 2;
    } else {
      // 구형 포맷 폴백 (rankCounts 없는 경우)
      if (hasWelding)     score -= 10;
      if (hasCorrosion)   score -= 5;
      if (hasReplacement) score -= 2;
    }

    return Math.max(0, score);
  }

  /**
   * 용도변경/렌트 점수 (rental 만점)
   */
  function scoreRental(data, maxPoints) {
    const { hasRentalHistory = false, hasUsageChange = false } = data;

    if (hasRentalHistory) return 0;
    if (hasUsageChange)   return maxPoints * 0.3;
    return maxPoints;
  }

  /**
   * 소유주 변경이력 점수 (ownerChanges 만점)
   */
  function scoreOwnerHistory(data, maxPoints) {
    const { ownerChangeCount = 0 } = data;

    if (ownerChangeCount === 0) return maxPoints;
    if (ownerChangeCount === 1) return maxPoints * 0.7;
    if (ownerChangeCount === 2) return maxPoints * 0.4;
    return maxPoints * 0.1;
  }

  /**
   * 종합 점수 계산
   */
  function calculateScore(carData, weights = DEFAULT_WEIGHTS, config = {}) {
    const scores = {
      accident:     scoreAccident(carData, weights.accident),
      mileage:      scoreMileage(carData, weights.mileage),
      price:        scorePrice(carData, weights.price, config),
      inspection:   scoreInspection(carData, weights.inspection),
      rental:       scoreRental(carData, weights.rental),
      ownerChanges: scoreOwnerHistory(carData, weights.ownerChanges ?? 0)
    };

    const totalScore = Math.round(
      scores.accident + scores.mileage + scores.price +
      scores.inspection + scores.rental + scores.ownerChanges
    );

    return {
      total: Math.min(100, totalScore),
      breakdown: scores,
      grade: getGrade(totalScore)
    };
  }

  function getGrade(score) {
    if (score >= 90) return 'S';
    if (score >= 85) return 'A+';
    if (score >= 80) return 'A';
    if (score >= 70) return 'B';
    if (score >= 60) return 'C';
    if (score > 40)  return 'D';
    return 'F';
  }

  function getGradeColor(grade) {
    const colors = { 'S': '#FFD700', 'A+': '#00BCD4', 'A': '#4CAF50', 'B': '#2196F3', 'C': '#FF9800', 'D': '#F44336', 'F': '#880000' };
    return colors[grade] || '#999';
  }

  function getGradeGradient(grade) {
    const gradients = {
      'S':  'linear-gradient(135deg, #FFD700, #FFA000)',
      'A+': 'linear-gradient(135deg, #00BCD4, #0097A7)',
      'A':  'linear-gradient(135deg, #4CAF50, #2E7D32)',
      'B':  'linear-gradient(135deg, #2196F3, #1565C0)',
      'C':  'linear-gradient(135deg, #FF9800, #E65100)',
      'D':  'linear-gradient(135deg, #F44336, #C62828)',
      'F':  'linear-gradient(135deg, #880000, #550000)'
    };
    return gradients[grade] || 'linear-gradient(135deg, #999, #666)';
  }

  return { calculateScore, getGrade, getGradeColor, getGradeGradient, DEFAULT_WEIGHTS };
})();
