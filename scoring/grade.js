/**
 * 등급 판정 및 등급별 색상/그래디언트 유틸리티
 */
((ns) => {
  ns.getGrade = function (score) {
    if (score >= 90) return 'S';
    if (score >= 85) return 'A+';
    if (score >= 80) return 'A';
    if (score >= 70) return 'B';
    if (score >= 60) return 'C';
    if (score > 40)  return 'D';
    return 'F';
  };

  ns.getGradeColor = function (grade) {
    const colors = { 'S': '#FFD700', 'A+': '#00BCD4', 'A': '#4CAF50', 'B': '#2196F3', 'C': '#FF9800', 'D': '#F44336', 'F': '#880000' };
    return colors[grade] || '#999';
  };

  ns.getGradeGradient = function (grade) {
    const gradients = {
      'S':  'linear-gradient(135deg, #FFD700, #FFA000)',
      'A+': 'linear-gradient(135deg, #00BCD4, #0097A7)',
      'A':  'linear-gradient(135deg, #4CAF50, #2E7D32)',
      'B':  'linear-gradient(135deg, #2196F3, #1565C0)',
      'C':  'linear-gradient(135deg, #FF9800, #E65100)',
      'D':  'linear-gradient(135deg, #F44336, #C62828)',
      'F':  'linear-gradient(135deg, #880000, #550000)'
    };
    return gradients[grade] || 'linear-gradient(135deg, #999, #666)';
  };
})(window.EncarScoring = window.EncarScoring || {});
