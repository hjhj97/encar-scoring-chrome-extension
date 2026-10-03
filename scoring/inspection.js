/**
 * 성능점검 점수 (inspection 만점)
 *
 * 사고·수리 기록 감점이 엔카진단보다 우선한다.
 * 엔카진단은 외판 교환 여부만 판정하므로, 진단 매물도 성능점검표의 교환·판금·부식을 먼저 감점한다.
 *
 * [일반 성능점검표 - 랭크별 패널티] (엔카진단 여부와 무관하게 항상 적용)
 *   골격 B랭크(대쉬·필러·사이드멤버): 교환 -15, 판금 -12 (per item)
 *   골격 A랭크(리어패널·트렁크플로어 등): 교환 -10, 판금 -8
 *   외판 2랭크(쿼터·펜더·루프): 교환 -4, 판금 -3
 *   외판 1랭크(도어·트렁크리드·후드): 교환 -1, 판금 -2
 *   부식: -2 per item (랭크 무관)
 *
 * [엔카진단] 성능점검표에 같은 종류의 교환 기록이 없을 때만 감점 (같은 수리를 두 번 감점하지 않음)
 *   - 프레임 교환: -12
 *   - 외부패널 교환: -3
 *
 * [진단 여부]
 *   - 엔카진단 미적용: -5
 *   - 엔카진단++: 사고·수리 감점이 없는 차량에만 +4 (감점을 상쇄하지 않음)
 */
((ns) => {
  /** 성능점검표 기록에 따른 감점 */
  function sheetDeduction(data) {
    const { hasWelding = false, hasCorrosion = false, hasReplacement = false, rankCounts = null } = data;
    if (!rankCounts) {
      return (hasWelding ? 10 : 0) + (hasCorrosion ? 5 : 0) + (hasReplacement ? 2 : 0);
    }
    const totalCorrosion = rankCounts.ONE.C + rankCounts.TWO.C + rankCounts.A.C + rankCounts.B.C;
    return rankCounts.B.X * 15 + rankCounts.B.W * 12 +
      rankCounts.A.X * 10 + rankCounts.A.W * 8 +
      rankCounts.TWO.X * 4 + rankCounts.TWO.W * 3 +
      rankCounts.ONE.X * 1 + rankCounts.ONE.W * 2 +
      totalCorrosion * 2;
  }

  /** 엔카진단 교환 판정 감점. 성능점검표에 이미 반영된 교환은 다시 감점하지 않는다. */
  function diagnosisDeduction(data) {
    const { hasInspection = false, hasReplacement = false, rankCounts = null,
            diagFrameReplacement = false, diagPanelReplacement = false } = data;
    const sheetFrameReplaced = hasInspection && rankCounts ? rankCounts.A.X + rankCounts.B.X > 0 : false;
    const sheetPanelReplaced = hasInspection && (rankCounts ? rankCounts.ONE.X + rankCounts.TWO.X > 0 : hasReplacement);
    return (diagFrameReplacement && !sheetFrameReplaced ? 12 : 0) +
      (diagPanelReplacement && !sheetPanelReplaced ? 3 : 0);
  }

  ns.scoreInspection = function (data, maxPoints) {
    if (data.isInspectionPrivate) return 0;

    const { hasInspection = false, hasDiagnosis = false, diagnosisTier = 'BASIC' } = data;

    // 성능점검표도 엔카진단도 없으면 판단 근거가 없으므로 절반에서 미진단 감점
    if (!hasInspection && !hasDiagnosis) return Math.max(0, maxPoints * 0.5 - 5);

    const repairDeduction = (hasInspection ? sheetDeduction(data) : 0) +
      (hasDiagnosis ? diagnosisDeduction(data) : 0);
    let score = maxPoints - repairDeduction - (hasDiagnosis ? 0 : 5);

    if (hasDiagnosis && diagnosisTier === 'PLUSPLUS' && repairDeduction === 0) score += 4;

    return Math.max(0, score);
  };
})(window.EncarScoring = window.EncarScoring || {});
