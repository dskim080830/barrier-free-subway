const { STATIONS: BASE_STATIONS, LINE_META } = require("../data/stations.js");
const { EDGES: BASE_EDGES } = require("../data/edges.js");

// scripts/import_stations.js 로 생성된 전체 수도권 데이터가 있으면 자동으로 병합합니다.
let GENERATED_STATIONS = [];
let GENERATED_EDGES = [];
try {
  GENERATED_STATIONS = require("../data/stations.generated.js").STATIONS_GENERATED || [];
} catch (_) {}
try {
  GENERATED_EDGES = require("../data/edges.generated.js").EDGES_GENERATED || [];
} catch (_) {}

const STATIONS = [...BASE_STATIONS, ...GENERATED_STATIONS];
const EDGES = [...BASE_EDGES, ...GENERATED_EDGES];

const stationById = new Map(STATIONS.map((s) => [s.id, s]));

/**
 * 인접 리스트 생성 (양방향)
 * adjacency: Map<stationId, Array<{ to: stationId, line }>>
 */
function buildAdjacency() {
  const adjacency = new Map();
  for (const station of STATIONS) adjacency.set(station.id, []);

  for (const edge of EDGES) {
    if (!stationById.has(edge.from) || !stationById.has(edge.to)) continue;
    adjacency.get(edge.from).push({ to: edge.to, line: edge.line });
    adjacency.get(edge.to).push({ to: edge.from, line: edge.line });
  }
  return adjacency;
}

const ADJACENCY = buildAdjacency();

/**
 * 배리어프리 BFS 최단 경로
 * @param {string} startId
 * @param {string} endId
 * @param {Map<string, {operational: boolean}>} elevatorStatus 역별 실시간 엘리베이터 상태 캐시
 * @param {Map<string, {operational: boolean}>} [liftStatus] 역별 실시간 휠체어리프트 상태 캐시.
 *        생략하면 리프트는 설치 여부(hasLiftInstalled)만으로 판단합니다.
 * @returns {{ ok: boolean, reason?: string, path?: string[], transfers?: Array, totalStops?: number }}
 */
function findBarrierFreeRoute(startId, endId, elevatorStatus, liftStatus) {
  if (!stationById.has(startId)) return { ok: false, reason: "출발역을 찾을 수 없습니다." };
  if (!stationById.has(endId)) return { ok: false, reason: "도착역을 찾을 수 없습니다." };

  const isUsable = (stationId) => {
    const station = stationById.get(stationId);

    // 엘리베이터: 설치되어 있고, 실시간 데이터상 고장이 아니면 이용 가능
    if (station.hasElevatorInstalled) {
      const live = elevatorStatus.get(stationId);
      if (!live || live.operational !== false) return true; // 데이터 없으면 정상 가정
    }

    // 엘리베이터가 없거나 고장이어도, 휠체어리프트가 설치되어 있고 정상이면 이용 가능
    // ⚠️ static station.hasLiftInstalled는 CSV에 컬럼이 없어 항상 false이므로,
    // 실시간 리프트 캐시(liftStatus)가 있으면 그 installed 값을 우선 신뢰하고,
    // 캐시 자체가 없을 때만(예: 최초 기동 직후) static 플래그로 폴백합니다.
    const liveLift = liftStatus ? liftStatus.get(stationId) : null;
    const liftInstalled = liveLift ? Boolean(liveLift.installed) : Boolean(station.hasLiftInstalled);
    if (liftInstalled) {
      const liftOperational = liveLift ? liveLift.operational !== false : true;
      if (liftOperational) return true;
    }

    return false;
  };

  if (!isUsable(startId)) {
    return {
      ok: false,
      reason: `출발역(${stationById.get(startId).name})에 지금 이용 가능한 엘리베이터/리프트가 없어 배리어프리 경로를 만들 수 없습니다.`,
    };
  }
  if (!isUsable(endId)) {
    return {
      ok: false,
      reason: `도착역(${stationById.get(endId).name})에 지금 이용 가능한 엘리베이터/리프트가 없어 배리어프리 경로를 만들 수 없습니다.`,
    };
  }

  // BFS: 큐에 (현재역, 직전 도착 노선) 저장 → 환승 지점 판별용
  const queue = [{ id: startId, viaLine: null }];
  const visited = new Set([startId]);
  const prev = new Map(); // stationId -> { from, line }

  let found = false;
  while (queue.length > 0) {
    const { id: current } = queue.shift();
    if (current === endId) {
      found = true;
      break;
    }
    const neighbors = ADJACENCY.get(current) || [];
    for (const { to, line } of neighbors) {
      if (visited.has(to)) continue;
      if (to !== endId && !isUsable(to)) continue; // 탐색 대상에서 원천 차단
      visited.add(to);
      prev.set(to, { from: current, line });
      queue.push({ id: to, viaLine: line });
    }
  }

  if (!found) {
    return {
      ok: false,
      reason:
        "계단 없이(엘리베이터만으로) 갈 수 있는 경로를 찾지 못했습니다. 현재 고장난 엘리베이터 때문일 수 있습니다.",
    };
  }

  // 경로 역추적
  const path = [endId];
  const lineOfSegment = []; // path[i] -> path[i+1] 구간의 호선, 역순
  let cur = endId;
  while (cur !== startId) {
    const { from, line } = prev.get(cur);
    lineOfSegment.unshift(line);
    path.unshift(from);
    cur = from;
  }

  // 환승 지점 계산 (구간의 호선이 바뀌는 지점)
  const transfers = [];
  for (let i = 1; i < lineOfSegment.length; i++) {
    if (lineOfSegment[i] !== lineOfSegment[i - 1]) {
      transfers.push({
        stationId: path[i],
        fromLine: lineOfSegment[i - 1],
        toLine: lineOfSegment[i],
      });
    }
  }

  return {
    ok: true,
    path,
    segmentLines: lineOfSegment,
    transfers,
    totalStops: path.length - 1,
  };
}

function getStationName(id) {
  const s = stationById.get(id);
  return s ? s.name : id;
}

function getLineLabel(lineKey) {
  const meta = LINE_META[lineKey];
  return meta ? meta.name : String(lineKey);
}

/**
 * "양재(서초구청)", "교대(법원·검찰청)"처럼 부기(副記)가 붙은 공식 역명에서
 * 괄호 부분을 뗀 "기본 역명"을 반환합니다. 외부 실시간 API(서울열린데이터광장,
 * 공공데이터포털 등)는 대개 괄호 없는 기본 역명만 인식하기 때문에, 화면
 * 표시용 전체 이름과 API 조회용 이름을 분리해서 써야 합니다.
 */
function baseStationName(name) {
  let s = String(name || "").replace(/\([^)]*\)\s*$/, "").trim();
  if (s.length > 1 && s.endsWith("역")) s = s.slice(0, -1);
  return s;
}

module.exports = {
  STATIONS,
  LINE_META,
  stationById,
  ADJACENCY,
  findBarrierFreeRoute,
  getStationName,
  getLineLabel,
  baseStationName,
};
