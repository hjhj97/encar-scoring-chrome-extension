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

// OpenAI API 호출 (content script에서 메시지로 요청)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ASK_OPENAI') {
    chrome.storage.local.get(['openaiApiKey'], async (result) => {
      const apiKey = result.openaiApiKey?.trim();
      if (!apiKey) {
        sendResponse({ error: 'API 키가 설정되지 않았습니다. 팝업에서 키를 입력해주세요.' });
        return;
      }
      try {
        const text = await askOpenAI(message.text, apiKey);
        sendResponse({ text });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true; // 비동기 응답 유지
  }
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
