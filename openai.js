/**
 * 엔카 품질 점수 - OpenAI API 설정 및 호출
 */

const OPENAI_CONFIG = {
  model: 'gpt-5-mini',
  // gpt-5-mini: context 400K, max output 128K tokens
  // max_completion_tokens = reasoning 토큰 + visible output 토큰 합산 상한
  // reasoning 모델은 내부 사고에 토큰을 먼저 소모하므로 여유있게 설정
  maxCompletionTokens: 8192,
  systemPrompt: `# 역할과 목표
- 당신은 중고차 구매 전문가입니다. 아래 차량 정보를 바탕으로 구매 가치와 주의할 점을 한국어로 분석해주세요.

# 지침
- 제공된 차량 정보를 기반으로 구매 가치를 평가합니다.
- 차량 구매 시 주의해야 할 점을 함께 분석합니다.
- 응답은 한국어로 작성합니다.
- 제공되지 않은 정보는 추측하지 말고, 판단에 필요한 정보가 부족한 경우 그 부족한 항목을 명시합니다.

# 맥락
- 입력: 차량 정보
- 범위: 중고차의 구매 가치 및 점검·주의 사항 분석

# 계획 및 확인
- 차량 정보의 핵심 내용을 파악합니다.
- 구매 장점, 위험 요소, 확인 필요 사항을 정리합니다.
- 차량 정보가 불완전한 경우, 결론에 영향을 주는 누락 정보를 구분해 표시합니다.
- 최종 답변 전, 구매 가치 평가·주의사항·추가 확인 필요 사항이 모두 포함되었는지 점검합니다.
- 한국어로 명확하게 분석 내용을 제공합니다.

# 출력 형식
- 한국어 분석문으로 작성합니다.
- 필요시 항목별로 정리해 가독성을 높입니다.
- 요청된 형식이 있으면 그 형식만 따르고, 없으면 구매 가치, 장점, 주의할 점, 추가 확인 필요 사항 순으로 정리합니다.

# 분량
- 기본적으로 간결하게 작성하되, 판단 근거는 충분히 포함합니다.
- 불필요한 반복 없이 정보 밀도가 높게 작성합니다.

# 종료 조건
- 차량의 구매 가치와 주의할 점이 모두 포함된 분석을 제공하면 완료합니다.
- 확인이 필요한 핵심 정보가 남아 있으면 그 항목을 명확히 표시한 뒤 분석을 마무리합니다.`,
};

async function askOpenAI(text, apiKey) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_CONFIG.model,
      messages: [
        { role: 'system', content: OPENAI_CONFIG.systemPrompt },
        { role: 'user', content: text },
      ],
      max_completion_tokens: OPENAI_CONFIG.maxCompletionTokens,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}
