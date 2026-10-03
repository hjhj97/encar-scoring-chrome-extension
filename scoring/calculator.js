/**
 * 종합 점수 계산 오케스트레이터
 * 개별 채점 모듈(accident, mileage, price, inspection, rental, owner)을
 * EncarScoring 네임스페이스에서 참조하여 종합 점수를 산출합니다.
 */
((ns) => {
  // DEFAULT_WEIGHTS는 constants.js에서 전역으로 로드됨
  const PRIVATE_PENALTY = 40;
  const WELD_CUT_PENALTY = 30;
  const TOTAL_LOSS_FLOOD_PENALTY = 30;

  /** 보험이력의 전손·침수(전손·분손) 기록 또는 성능점검표 침수 표시가 있는지 */
  ns.hasTotalLossOrFlood = function (carData) {
    return (carData.totalLossCount ?? 0) > 0 ||
      (carData.floodTotalLossCount ?? 0) > 0 ||
      (carData.floodPartLossCount ?? 0) > 0 ||
      carData.inspectionFlood === true;
  };

  ns.calculateScore = function (carData, weights = DEFAULT_WEIGHTS, config = {}) {
    const scores = {
      accident:     ns.scoreAccident(carData, weights.accident),
      mileage:      ns.scoreMileage(carData, weights.mileage),
      price:        ns.scorePrice(carData, weights.price, config),
      inspection:   ns.scoreInspection(carData, weights.inspection),
      rental:       ns.scoreRental(carData, weights.rental),
      ownerChanges: ns.scoreOwnerHistory(carData, weights.ownerChanges ?? 0)
    };

    let totalScore = Math.round(
      scores.accident + scores.mileage + scores.price +
      scores.inspection + scores.rental + scores.ownerChanges
    );

    // 항목 배점으로 담을 수 없는 결격 사유는 종합점수에서 직접 감점한다.
    const penalties = [];
    if (carData.isInsurancePrivate || carData.isInspectionPrivate) {
      penalties.push({ key: 'private', label: '미공개 항목', points: PRIVATE_PENALTY });
    }
    // 용접·절단: 차체에 용접된 패널(쿼터·사이드실 등)을 잘라내고 다시 붙인 수리. 부위 수와 관계없이 한 번만 감점
    if (carData.hasWeldCut) {
      penalties.push({ key: 'weldCut', label: '용접·절단', points: WELD_CUT_PENALTY });
    }
    // 전손·침수: 전손·침수 중 하나라도 있으면 한 번만 감점
    if (ns.hasTotalLossOrFlood(carData)) {
      penalties.push({ key: 'totalLossFlood', label: '전손·침수', points: TOTAL_LOSS_FLOOD_PENALTY });
    }
    const penalty = penalties.reduce((sum, item) => sum + item.points, 0);
    totalScore -= penalty;

    return {
      total: Math.min(100, Math.max(0, totalScore)),
      breakdown: scores,
      penalty,
      penalties,
      grade: ns.getGrade(totalScore)
    };
  };

  // 기존 API 호환을 위해 DEFAULT_WEIGHTS도 네임스페이스에 노출
  ns.DEFAULT_WEIGHTS = DEFAULT_WEIGHTS;
})(window.EncarScoring = window.EncarScoring || {});
