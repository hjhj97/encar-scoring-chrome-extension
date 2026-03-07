/**
 * 소유주 변경이력 점수 (ownerChanges 만점)
 */
((ns) => {
  ns.scoreOwnerHistory = function (data, maxPoints) {
    const { ownerChangeCount = 0 } = data;

    if (ownerChangeCount === 0) return maxPoints;

    let deductionPoints = 0;
    if (ownerChangeCount === 1) deductionPoints = 3;
    else if (ownerChangeCount === 2) deductionPoints = 7;
    else if (ownerChangeCount === 3) deductionPoints = 10;
    else if (ownerChangeCount >= 4) deductionPoints = 15;

    // 기준 배점이 15점이라는 가정 하에 슬라이더 변동 대응
    const deductionRatio = deductionPoints / 15;
    return Math.max(0, maxPoints * (1 - deductionRatio));
  };
})(window.EncarScoring = window.EncarScoring || {});
