const { STATIONS, baseStationName } = require("./graph.js");
const { fetchElevatorStatusAll, fetchLiftStatusAll, clearSeoulRawCaches } = require("./seoulOpenApi.js");

// stationId -> { operational: boolean, brokenFacilities: string[], updatedAt: number }
const cache = new Map(); // 엘리베이터
const liftCache = new Map(); // 휠체어리프트

// 최초에는 모두 "정상"으로 간주 (설치 여부는 graph.js 의 hasElevatorInstalled/hasLiftInstalled 가 별도로 판단)
for (const s of STATIONS) {
  cache.set(s.id, { operational: true, brokenFacilities: [], updatedAt: 0 });
  liftCache.set(s.id, { operational: true, brokenFacilities: [], updatedAt: 0 });
}

async function refresh() {
  // 매 refresh 주기마다 서울열린데이터광장 원본 응답(리프트/빠른하차) 캐시도
  // 함께 비워서, 최신 데이터를 다시 받아오도록 합니다.
  clearSeoulRawCaches();

  // ⚠️ "양재(서초구청)"처럼 부기가 붙은 역명은 API가 못 알아들어서, 조회용
  // 키는 괄호를 뗀 기본 역명으로 묶습니다 (여러 station id가 같은 기본
  // 역명을 공유할 수 있음 — 그럼 API 호출도 자연히 줄어듭니다).
  const elevatorBaseNameToIds = new Map();
  const liftBaseNameToIds = new Map();
  for (const s of STATIONS) {
    const base = baseStationName(s.name);
    if (s.hasElevatorInstalled) {
      if (!elevatorBaseNameToIds.has(base)) elevatorBaseNameToIds.set(base, []);
      elevatorBaseNameToIds.get(base).push(s.id);
    }
    if (s.hasLiftInstalled) {
      if (!liftBaseNameToIds.has(base)) liftBaseNameToIds.set(base, []);
      liftBaseNameToIds.get(base).push(s.id);
    }
  }

  const now = Date.now();

  const elevatorStatusByName = await fetchElevatorStatusAll([...elevatorBaseNameToIds.keys()]);
  for (const [base, ids] of elevatorBaseNameToIds.entries()) {
    const status = elevatorStatusByName.get(base);
    if (!status) continue; // 조회 실패 시 직전 캐시 유지 (섣불리 "정상"으로 덮어쓰지 않음)
    for (const id of ids) cache.set(id, { ...status, updatedAt: now });
  }

  const liftStatusByName = await fetchLiftStatusAll([...liftBaseNameToIds.keys()]);
  for (const [base, ids] of liftBaseNameToIds.entries()) {
    const status = liftStatusByName.get(base);
    if (!status) continue;
    for (const id of ids) liftCache.set(id, { ...status, updatedAt: now });
  }
}

function getStatus(stationId) {
  return cache.get(stationId);
}

function getLiftStatus(stationId) {
  return liftCache.get(stationId);
}

function getFullCache() {
  return cache;
}

function getFullLiftCache() {
  return liftCache;
}

function startAutoRefresh() {
  const intervalMs = Number(process.env.ELEVATOR_REFRESH_INTERVAL_MS || 180000);
  refresh().catch((err) => console.error("[elevatorStatusCache] 초기 갱신 실패:", err.message));
  setInterval(() => {
    refresh().catch((err) => console.error("[elevatorStatusCache] 갱신 실패:", err.message));
  }, intervalMs);
}

module.exports = { getStatus, getLiftStatus, getFullCache, getFullLiftCache, refresh, startAutoRefresh };
