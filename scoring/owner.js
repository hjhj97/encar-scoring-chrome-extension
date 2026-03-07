/**
 * 소유주 변경이력 점수 (ownerChanges 만점)
 */
((ns) => {
  ns.scoreOwnerHistory = function (data, maxPoints) {
    const { ownerChangeCount = 0 } = data;

    if (ownerChangeCount === 0) return maxPoints;
    if (ownerChangeCount === 1) return maxPoints * 0.7;
    if (ownerChangeCount === 2) return maxPoints * 0.4;
    return maxPoints * 0.1;
  };
})(window.EncarScoring = window.EncarScoring || {});
