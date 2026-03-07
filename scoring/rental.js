/**
 * 용도변경/렌트 점수 (rental 만점)
 */
((ns) => {
  ns.scoreRental = function (data, maxPoints) {
    const { hasRentalHistory = false, hasUsageChange = false } = data;

    if (hasRentalHistory) return 0;
    if (hasUsageChange)   return maxPoints * 0.3;
    return maxPoints;
  };
})(window.EncarScoring = window.EncarScoring || {});
