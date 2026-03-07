/**
 * 종합 점수 계산 오케스트레이터
 * 개별 채점 모듈(accident, mileage, price, inspection, rental, owner)을
 * EncarScoring 네임스페이스에서 참조하여 종합 점수를 산출합니다.
 */
((ns) => {
  // DEFAULT_WEIGHTS는 constants.js에서 전역으로 로드됨

  ns.calculateScore = function (carData, weights = DEFAULT_WEIGHTS, config = {}) {
    const scores = {
      accident:     ns.scoreAccident(carData, weights.accident),
      mileage:      ns.scoreMileage(carData, weights.mileage),
      price:        ns.scorePrice(carData, weights.price, config),
      inspection:   ns.scoreInspection(carData, weights.inspection),
      rental:       ns.scoreRental(carData, weights.rental),
      ownerChanges: ns.scoreOwnerHistory(carData, weights.ownerChanges ?? 0)
    };

    const totalScore = Math.round(
      scores.accident + scores.mileage + scores.price +
      scores.inspection + scores.rental + scores.ownerChanges
    );

    return {
      total: Math.min(100, Math.max(0, totalScore)),
      breakdown: scores,
      grade: ns.getGrade(totalScore)
    };
  };

  // 기존 API 호환을 위해 DEFAULT_WEIGHTS도 네임스페이스에 노출
  ns.DEFAULT_WEIGHTS = DEFAULT_WEIGHTS;
})(window.EncarScoring = window.EncarScoring || {});
