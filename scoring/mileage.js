/**
 * 주행거리 점수 (mileage 만점)
 * - 총 주행거리: 15만km부터 1만km마다 1점 감점, 20만km 이상부터는 1만km마다 2점 감점
 * - 연간 주행거리: 5천km 이하인 경우 1천km마다 2점 감점
 */
((ns) => {
  ns.scoreMileage = function (data, maxPoints) {
    const { mileage = 0, year = 0, month = 0 } = data;
    if (!year || !mileage) return maxPoints * 0.5;

    const now = new Date();
    const nowYear = now.getFullYear(), nowMonth = now.getMonth() + 1;
    const ageMonths = (month > 0)
      ? Math.max(1, (nowYear - (2000 + year)) * 12 + (nowMonth - month))
      : Math.max(12, (nowYear - (2000 + year)) * 12);
    const avgAnnualKm = mileage / ageMonths * 12;

    let deduction = 0;

    // 총 주행거리 감점
    if (mileage >= 150000) {
      // 15만~20만km 구간: 1만km마다 1점
      deduction += Math.floor((Math.min(mileage, 200000) - 150000) / 10000);
      // 20만km 이상 구간: 1만km마다 2점
      if (mileage >= 200000) {
        deduction += Math.floor((mileage - 200000) / 10000) * 2;
      }
    }

    // 연간 주행거리 감점: 5천km 이하인 경우 1천km마다 2점
    if (avgAnnualKm <= 5000) {
      deduction += Math.floor((5000 - avgAnnualKm) / 1000) * 2;
    }

    return Math.max(0, maxPoints - deduction);
  };
})(window.EncarScoring = window.EncarScoring || {});
