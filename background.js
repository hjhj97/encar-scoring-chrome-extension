/**
 * 엔카 품질 점수 - Background Service Worker
 */

importScripts('constants.js', 'openai.js');

// 설치 시 기본 설정 (DEFAULT_WEIGHTS는 constants.js에서 로드)
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    weights: DEFAULT_WEIGHTS,
    minScore: 0
  });
  console.log('[EncarScore] 익스텐션 설치 완료');
});

// OpenAI API 스트리밍 호출 (포트 연결 방식)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'openai-stream') return;

  port.onMessage.addListener(async (message) => {
    if (message.type !== 'ASK_OPENAI_STREAM') return;

    const result = await chrome.storage.local.get(['openaiApiKey']);
    const apiKey = result.openaiApiKey?.trim();
    if (!apiKey) {
      port.postMessage({ type: 'error', error: 'API 키가 설정되지 않았습니다. 팝업에서 키를 입력해주세요.' });
      return;
    }

    try {
      const fullText = await askOpenAIStream(message.text, apiKey, (chunk) => {
        port.postMessage({ type: 'chunk', chunk });
      });
      port.postMessage({ type: 'done', text: fullText });
    } catch (err) {
      port.postMessage({ type: 'error', error: err.message });
    }
  });
});

// 탭 업데이트 시 아이콘 상태 관리
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (tab.url.includes('car.encar.com/list')) {
      // 엔카 리스트 페이지 → 아이콘 활성화
      chrome.action.setIcon({
        tabId,
        path: {
          16: 'icons/icon16.png',
          48: 'icons/icon48.png',
          128: 'icons/icon128.png'
        }
      });
    }
  }
});
