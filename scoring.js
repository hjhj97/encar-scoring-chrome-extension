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

    // 기본 사고 점수: 가장 큰 단일 건 기준
    let baseScore;
    if (accidentAmounts.length === 0) {
      baseScore = maxPoints; // 무사고
    } else if (originPrice > 0) {
      const originWon     = originPrice * 10000;
      const maxSingleRatio = Math.max(...accidentAmounts) / originWon;

      if (maxSingleRatio <= 0.10) baseScore = maxPoints * 0.75; // 10% 이하: 경미
      else if (maxSingleRatio <= 0.20) baseScore = maxPoints * 0.45; // 10~20%: 중간
      else baseScore = maxPoints * 0.1;                              // 20% 초과: 심각
    } else {
      // originPrice 없는 경우 최대 단일 건 절대 금액 기준
      const maxSingle = Math.max(...accidentAmounts);
      if (maxSingle < 500000)    baseScore = maxPoints * 0.85;
      else if (maxSingle < 2000000) baseScore = maxPoints * 0.6;
      else if (maxSingle < 5000000) baseScore = maxPoints * 0.35;
      else baseScore = maxPoints * 0.1;
    }

    // 정보제공 불가능기간 패널티 (6개월 이내 -10점, 초과 -20점)
    if (hasUnavailablePeriod) {
      const months  = calcUnavailableMonths(unavailablePeriods);
      const penalty = months <= 6 ? 10 : 20;
      baseScore = Math.max(0, baseScore - penalty);
    }

    return baseScore;
  }

  /**
   * 주행거리 점수 (mileage 만점)
   */
  function scoreMileage(data, maxPoints) {
    const { mileage = 0, year = 0 } = data;
    if (!year || !mileage) return maxPoints * 0.5;

    const currentYear = new Date().getFullYear();
    const carAge = Math.max(1, currentYear - (2000 + year));
    const avgAnnualKm = mileage / carAge;

    if (avgAnnualKm <= 10000) return maxPoints;
    if (avgAnnualKm <= 15000) return maxPoints * 0.9;
    if (avgAnnualKm <= 20000) return maxPoints * 0.7;
    if (avgAnnualKm <= 30000) return maxPoints * 0.5;
    if (avgAnnualKm <= 40000) return maxPoints * 0.3;
    return maxPoints * 0.1;
  }

  /**
   * 가격 점수 (price 만점)
   *
   * 신차가 대비 실제 감가율 vs 연식별 기대 감가율 비교
   * priceRatio = 실제가 / 기대가 → 낮을수록 저렴 → 높은 점수
   */
  function scorePrice(data, maxPoints, config = {}) {
    const { price = 0, year = 0, originPrice = 0 } = data;

    // ── 절대가격 모드 (가격우선 프리셋) ──
    if (config.priceMode === 'absolute') {
      if (!price) return maxPoints * 0.5;
      // 단순히 가격이 낮을수록 높은 점수 (만원 단위)
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
    if (!price || !year || !originPrice) return maxPoints * 0.5;

    const currentYear = new Date().getFullYear();
    const carAge = Math.max(1, currentYear - (2000 + year));

    // 연식별 기대 잔존가치 비율 (현실적 중고차 시세 반영)
    //              0년  1년   2년   3년   4년   5년   6년   7년   8년   9년  10년+
    const RETENTION = [1.0, 0.85, 0.75, 0.66, 0.58, 0.52, 0.46, 0.41, 0.37, 0.33, 0.30];
    const expectedRetention = RETENTION[Math.min(carAge, 10)];
    const expectedPrice     = originPrice * expectedRetention;
    const priceRatio        = price / expectedPrice;

    // 기대가 대비 저렴할수록 높은 점수, 비싸도 완만하게 감점
    if (priceRatio <= 0.85) return maxPoints;
    if (priceRatio <= 0.95) return maxPoints * 0.9;
    if (priceRatio <= 1.00) return maxPoints * 0.8;
    if (priceRatio <= 1.05) return maxPoints * 0.7;
    if (priceRatio <= 1.10) return maxPoints * 0.6;
    if (priceRatio <= 1.15) return maxPoints * 0.5;
    if (priceRatio <= 1.25) return maxPoints * 0.35;
    if (priceRatio <= 1.35) return maxPoints * 0.2;
    return maxPoints * 0.1;                          // 35% 초과해도 최소 10%
  }

  /**
   * 성능점검 점수 (inspection 만점)
   *
   * [엔카진단]
   *   - 프레임 교환: 큰 감점 (-12점)
   *   - 외부패널 교환: 작은 감점 (-3점)
   *
   * [일반 성능점검표]
   *   - 판금(용접): 큰 감점 (-10점)
   *   - 부식: 중간 감점 (-5점)
   *   - 교환: 작은 감점 (-2점)
   *   - 미등록: 절반
   */
  function scoreInspection(data, maxPoints) {
    if (data.isInspectionPrivate) return 0; // 성능점검 비공개 → 0점

    let score = maxPoints;
    const {
      hasInspection = false, hasReplacement = false, hasWelding = false, hasCorrosion = false,
      hasDiagnosis  = false, diagFrameReplacement = false, diagPanelReplacement = false
    } = data;

    if (hasDiagnosis) {
      if (diagFrameReplacement) score -= 12;
      if (diagPanelReplacement) score -= 3;
      return Math.max(0, score);
    }

    if (!hasInspection) return maxPoints * 0.5;
    if (hasWelding)     score -= 10;
    if (hasCorrosion)   score -= 5;
    if (hasReplacement) score -= 2;
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
