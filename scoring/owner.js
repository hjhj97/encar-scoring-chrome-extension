/**
 * 소유주 변경이력 점수 (ownerChanges 만점)
 */
((ns) => {
  ns.scoreOwnerHistory = function (data, maxPoints) {
    const { ownerChangeCount = 0 } = data;

    if (ownerChangeCount === 0) return maxPoints;

    // 가중치(maxPoints)의 변화에 유연하게 대응하도록 감점율(%)을 지정
    // 15점 만점 기준: 3점(20%), 7점(47%), 10점(67%), 15점(100%)
    let deductionRatio = 0;
    if (ownerChangeCount === 1) deductionRatio = 0.20;
    else if (ownerChangeCount === 2) deductionRatio = 0.47;
    else if (ownerChangeCount === 3) deductionRatio = 0.67;
    else if (ownerChangeCount >= 4) deductionRatio = 1.0;

    return Math.max(0, maxPoints * (1 - deductionRatio));
  };
})(window.EncarScoring = window.EncarScoring || {});
