/**
 * 가격 점수 (price 만점)
 *
 * 동급매물 5대 이상 확보 시: 시세 중앙값 대비 비율로 산정
 * 5대 미만(데이터 부족) 시: 신차가 대비 감가율로 산정
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

  ns.scorePrice = function (data, maxPoints, config = {}) {
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

    // A) 동급매물 시세 기반
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
  };
})(window.EncarScoring = window.EncarScoring || {});
