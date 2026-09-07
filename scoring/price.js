/**
 * 가격 점수 (price 만점)
 *
 * 동일 모델·트림의 같은 출고연도 평균가격 대비 비율로 산정한다.
 * 평균가격 데이터가 없으면 가격 항목 배점의 50%를 부여한다.
 */
((ns) => {
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

  function getFullYear(year) {
    const parsed = parseInt(year, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed < 100 ? 2000 + parsed : parsed;
  }

  /**
   * 현재 차량과 출고연도가 같은 연식별 시세 포인트를 찾는다.
   * year를 우선 사용하여 실행 연도가 바뀌어도 잘못된 age 포인트와 매칭되지 않게 한다.
   */
  function getYearlyPricePoint(data) {
    const fullYear = getFullYear(data?.year);
    const points = data?.yearlyMarketData?.points;
    if (!fullYear || !Array.isArray(points)) return null;

    const currentYear = new Date().getFullYear();
    const carAge = Math.max(0, currentYear - fullYear);
    const point = points.find(item => Number(item.year) === fullYear)
      || points.find(item => Number(item.age) === carAge);

    if (!point || !Number.isFinite(point.avgPrice) || point.avgPrice <= 0) return null;
    return point;
  }

  ns.getYearlyPricePoint = getYearlyPricePoint;

  ns.scorePrice = function (data, maxPoints) {
    const price = data?.price ?? 0;
    if (!price) return maxPoints * 0.5;

    const yearlyPoint = getYearlyPricePoint(data);
    if (yearlyPoint) {
      return ratioToScore(price / yearlyPoint.avgPrice, maxPoints);
    }

    return maxPoints * 0.5;
  };
})(window.EncarScoring = window.EncarScoring || {});
