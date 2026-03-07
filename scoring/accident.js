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
((ns) => {
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

  ns.scoreAccident = function (data, maxPoints) {
    const {
      isInsurancePrivate = false,
      originPrice        = 0,
      accidentAmounts    = [],
      hasUnavailablePeriod = false,
      unavailablePeriods   = []
    } = data;

    if (isInsurancePrivate) return 0;

    let baseScore;
    if (accidentAmounts.length === 0) {
      baseScore = maxPoints;
    } else if (originPrice > 0) {
      const originWon      = originPrice * 10000;
      const maxSingleRatio = Math.max(...accidentAmounts) / originWon;

      if (maxSingleRatio <= 0.08) baseScore = maxPoints * 0.75;
      else if (maxSingleRatio <= 0.15) baseScore = maxPoints * 0.45;
      else baseScore = maxPoints * 0.1;
    } else {
      const maxSingle = Math.max(...accidentAmounts);
      if (maxSingle < 500000)       baseScore = maxPoints * 0.85;
      else if (maxSingle < 2000000) baseScore = maxPoints * 0.6;
      else if (maxSingle < 5000000) baseScore = maxPoints * 0.35;
      else baseScore = maxPoints * 0.1;
    }

    if (accidentAmounts.length >= 4) baseScore = Math.max(0, baseScore - 5);
    else if (accidentAmounts.length >= 2) baseScore = Math.max(0, baseScore - 2);

    if (hasUnavailablePeriod) {
      const months  = calcUnavailableMonths(unavailablePeriods);
      const penalty = months <= 1 ? 0 : months <= 6 ? 10 : 20;
      baseScore = Math.max(0, baseScore - penalty);
    }

    return baseScore;
  };
})(window.EncarScoring = window.EncarScoring || {});
