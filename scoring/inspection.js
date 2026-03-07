/**
 * 성능점검 점수 (inspection 만점)
 *
 * [엔카진단]
 *   - 프레임 교환: 큰 감점 (-12점)
 *   - 외부패널 교환: 작은 감점 (-3점)
 *
 * [일반 성능점검표 - 랭크별 패널티]
 *   골격 B랭크(대쉬·필러·사이드멤버): 교환 -15, 판금 -12 (per item)
 *   골격 A랭크(리어패널·트렁크플로어 등): 교환 -10, 판금 -8
 *   외판 2랭크(쿼터·펜더·루프): 교환 -4, 판금 -3
 *   외판 1랭크(도어·트렁크리드·후드): 교환 -1, 판금 -2
 *   부식: -2 per item (랭크 무관)
 */
((ns) => {
  ns.scoreInspection = function (data, maxPoints) {
    if (data.isInspectionPrivate) return 0;

    let score = maxPoints;
    const {
      hasInspection = false, hasReplacement = false, hasWelding = false, hasCorrosion = false,
      hasDiagnosis  = false, diagFrameReplacement = false, diagPanelReplacement = false,
      rankCounts    = null
    } = data;

    if (!hasDiagnosis) {
      score -= 5;
    }

    if (hasDiagnosis) {
      if (diagFrameReplacement) score -= 12;
      if (diagPanelReplacement) score -= 3;
      const { diagnosisTier = 'BASIC' } = data;
      if (diagnosisTier === 'PLUSPLUS') score += 4;
      return Math.max(0, score);
    }

    if (!hasInspection) return Math.max(0, maxPoints * 0.5 - 5);

    if (rankCounts) {
      score -= rankCounts.B.X * 15;
      score -= rankCounts.B.W * 12;
      score -= rankCounts.A.X * 10;
      score -= rankCounts.A.W * 8;
      score -= rankCounts.TWO.X * 4;
      score -= rankCounts.TWO.W * 3;
      score -= rankCounts.ONE.X * 1;
      score -= rankCounts.ONE.W * 2;
      const totalCorrosion = rankCounts.ONE.C + rankCounts.TWO.C + rankCounts.A.C + rankCounts.B.C;
      score -= totalCorrosion * 2;
    } else {
      if (hasWelding)     score -= 10;
      if (hasCorrosion)   score -= 5;
      if (hasReplacement) score -= 2;
    }

    return Math.max(0, score);
  };
})(window.EncarScoring = window.EncarScoring || {});
