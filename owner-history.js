/**
 * 날짜 패턴을 이용한 딜러 경유 보정 안내. 원본 이력과 채점에는 사용하지 않는다.
 * 실제 소유자 유형을 확인한 결과가 아니므로 모든 보정값은 추정치다.
 */
const OwnerHistory = (() => {
  const DAY_MS = 86400000;
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

  /** 시간대/DST와 무관한 달력 날짜. 같은 날짜의 여러 변경도 서로 다른 기록이다. */
  function calendarDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.getTime() / DAY_MS;
  }

  /** 시간대 없는 엔카 등록 시각은 한국 시간으로 해석한다. 광고일로 대체하지 않는다. */
  function registrationDay(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/i);
    if (!match || calendarDay(match[1]) === null ||
        +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return null;
    const time = Date.parse(match[5] ? value : `${value}+09:00`);
    return Number.isFinite(time) ? Math.floor((time + KST_OFFSET_MS) / DAY_MS) : null;
  }

  /**
   * 먼저 현재 딜러 매입 후보를 분리하고, 남은 과거 기록을 중복 없이 묶는다.
   * 짧은 간격이 이어져도 전체 30일을 넘는 연쇄를 임의로 잘라 보정하지 않는다.
   * 31~60일 쌍의 독립성은 보정 전 원본의 앞뒤 변경(60일 초과)으로 판단한다.
   */
  function estimate(data = {}, now = Date.now()) {
    const rawCount = data.ownerChangeCount;
    const unavailable = reason => ({
      status: 'unavailable', rawCount, estimatedCount: null, excludedCount: 0,
      currentDealerPurchase: null, historicalGroups: [], reason
    });
    if (data.isInsurancePrivate) return unavailable('소유주 이력 조회 불가');
    if (data.ownerHistoryComplete === false || !Number.isInteger(rawCount) || rawCount < 0 ||
        !Array.isArray(data.ownerChanges) || data.ownerChanges.length !== rawCount) {
      return unavailable('명의 변경 횟수·날짜 누락 또는 불일치');
    }

    const firstDay = calendarDay(data.firstRegistrationDate);
    const registeredDay = registrationDay(data.registDateTime);
    const today = Number.isFinite(now) ? Math.floor((now + KST_OFFSET_MS) / DAY_MS) : null;
    if (firstDay === null || registeredDay === null || today === null ||
        registeredDay < firstDay || registeredDay > today) {
      return unavailable('최초 등록일·엔카 등록일 미확인 또는 날짜 오류');
    }
    const changes = data.ownerChanges.map((date, originalIndex) => ({
      date, originalIndex, day: calendarDay(date)
    }));
    if (changes.some(item => item.day === null || item.day < firstDay || item.day > today)) {
      return unavailable('명의 변경일 누락 또는 날짜 오류');
    }
    changes.sort((a, b) => a.day - b.day || a.originalIndex - b.originalIndex);
    changes.forEach((item, index) => { item.index = index; });

    const last = changes[changes.length - 1];
    const isDealer = String(data.sellerUserType || '').trim().toUpperCase() === 'DEALER';
    const currentDealerPurchase = isDealer && last &&
      registeredDay - last.day >= 0 && registeredDay - last.day <= 30 ? last : null;
    // 등록 후 변경은 과거 묶음에도 넣지 않는다. 마지막 후보도 두 번 보정하지 않는다.
    const historical = changes.filter(item => item !== currentDealerPurchase && item.day <= registeredDay);
    const groups = [];
    const assigned = new Map();
    const blocked = new Set();
    const addGroup = (items, rule) => {
      const groupId = groups.length;
      groups.push({
        rule, dates: items.map(item => item.date),
        originalIndexes: items.map(item => item.originalIndex),
        spanDays: items[items.length - 1].day - items[0].day,
        excludedCount: items.length - 1
      });
      items.forEach(item => assigned.set(item.index, groupId));
    };

    // 인접 간격 30일 이내의 최대 연쇄를 찾되, 전체 기간이 30일 이내일 때만 묶는다.
    for (let start = 0; start < historical.length;) {
      let end = start + 1;
      while (end < historical.length && historical[end].day - historical[end - 1].day <= 30) end++;
      const run = historical.slice(start, end);
      if (run.length > 1) {
        if (run[run.length - 1].day - run[0].day <= 30) addGroup(run, 'within30');
        else run.forEach(item => blocked.add(item.index));
      }
      start = end;
    }

    // 이미 묶거나 보류한 기록을 재사용하지 않고, 고립된 원본 두 건만 보정한다.
    for (let i = 0; i + 1 < historical.length; i++) {
      const left = historical[i], right = historical[i + 1];
      if ([left, right].some(item => assigned.has(item.index) || blocked.has(item.index))) continue;
      const gap = right.day - left.day;
      const before = changes[left.index - 1], after = changes[right.index + 1];
      if (right.index === left.index + 1 && gap > 30 && gap <= 60 &&
          (!before || left.day - before.day > 60) && (!after || after.day - right.day > 60)) {
        addGroup([left, right], 'isolated60');
      }
    }

    // 가까운 변경이 남았지만 위 조건을 충족하지 못했다면 남은 원본 횟수는 유지한다.
    const hasDeferredChanges = historical.some((item, i) => {
      const next = historical[i + 1];
      return next && next.day - item.day <= 60 &&
        !(assigned.has(item.index) && assigned.get(item.index) === assigned.get(next.index));
    });
    const excludedCount = (currentDealerPurchase ? 1 : 0) +
      groups.reduce((sum, group) => sum + group.excludedCount, 0);
    return {
      status: hasDeferredChanges ? 'partial' : 'estimated', rawCount,
      estimatedCount: rawCount - excludedCount, excludedCount,
      currentDealerPurchase, historicalGroups: groups, reason: null
    };
  }

  /** 툴팁과 복사 텍스트에서 동일한 추정/보류 안내를 사용한다. */
  function describe(result) {
    if (result.status === 'unavailable') {
      return { text: '딜러 경유 보정: 추정 불가', title: `${result.reason}. 원본 이력과 점수는 유지합니다.` };
    }
    const partial = result.status === 'partial';
    const text = partial && result.excludedCount === 0
      ? '딜러 경유 보정: 판정 보류'
      : `딜러 경유 보정 시 ${result.estimatedCount}회 추정${partial ? ' · 일부 판정 보류' : ''}`;
    const details = ['날짜 패턴에 따른 추정이며 실제 소유자 유형을 확인한 결과가 아닙니다. 원본 이력·점수에는 반영하지 않습니다.'];
    if (result.currentDealerPurchase) {
      details.push(`현재 딜러 매입 후보 ${result.currentDealerPurchase.date}: 엔카 등록 전 0~30일의 마지막 변경 1회 제외.`);
    }
    result.historicalGroups.forEach(group => {
      details.push(`과거 경유 후보 ${group.dates.join(', ')}: 전체 ${group.spanDays}일, ${group.dates.length}회를 1회로 추정.`);
    });
    if (partial) details.push('조건을 충족하지 못한 연쇄 변경은 보류하고 원본 횟수대로 남겼습니다.');
    if (!result.excludedCount) details.push('제외한 변경 없음.');
    if (result.estimatedCount === 0) details.push('1인 소유가 확인되었다는 뜻은 아닙니다.');
    return { text, title: details.join('\n') };
  }

  return { estimate, describe };
})();
