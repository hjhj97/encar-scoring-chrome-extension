/**
 * 엔카 품질 점수 - 공통 상수
 * DEFAULT_WEIGHTS를 단일 소스로 관리합니다.
 * content scripts, popup, background 모두 이 파일을 로드합니다.
 */

const DEFAULT_WEIGHTS = {
  accident:     20,  // 사고/보험이력 (ํ†ตํ•©)
  mileage:      10,  // 주행거리
  price:        25,  // 가격 대비 가치
  inspection:   15,  // 성능점검 결과
  rental:       20,  // 용도변경/렌트
  ownerChanges: 10   // 소유주 변경이력
};
