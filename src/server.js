require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { STATIONS, LINE_META, findBarrierFreeRoute, getStationName, getLineLabel, stationById, baseStationName } = require("./graph.js");
const elevatorStatusCache = require("./elevatorStatusCache.js");
const { fetchQuickExitInfo, fetchElevatorStatusAll, fetchLiftStatusAll, fetchRealtimeArrival, setMockBrokenStation, USE_MOCK } = require("./seoulOpenApi.js");
const odsayApi = require("./odsayApi.js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// 전체 역 목록 (검색용)
app.get("/api/stations", (req, res) => {
  const list = STATIONS.map((s) => ({
    id: s.id,
    name: s.name,
    lines: s.lines,
    lat: s.lat,
    lng: s.lng,
    hasElevatorInstalled: s.hasElevatorInstalled,
    hasLiftInstalled: Boolean(s.hasLiftInstalled),
  }));
  res.json({ stations: list, lineMeta: LINE_META });
});

// 역별 현재 엘리베이터·휠체어리프트 상태 스냅샷
app.get("/api/elevator-status", (req, res) => {
  const cache = elevatorStatusCache.getFullCache();
  const liftCache = elevatorStatusCache.getFullLiftCache();
  const out = {};
  for (const s of STATIONS) {
    const live = cache.get(s.id);
    const liveLift = liftCache.get(s.id);
    out[s.id] = {
      name: s.name,
      hasElevatorInstalled: s.hasElevatorInstalled,
      operational: s.hasElevatorInstalled ? !!live?.operational : false,
      brokenFacilities: live?.brokenFacilities || [],
      updatedAt: live?.updatedAt || 0,
      // ⚠️ 리프트 설치여부는 더 이상 static 데이터(s.hasLiftInstalled, 항상 false)가
      // 아니라 mtrWheelLift 실시간 API 결과(liveLift.installed)를 기준으로 판단합니다.
      hasLiftInstalled: Boolean(liveLift?.installed),
      liftOperational: liveLift?.installed ? !!liveLift?.operational : false,
    };
  }
  res.json({ mock: USE_MOCK, stations: out });
});

// 특정 역의 실시간 지하철 도착정보 (서울시 지하철 실시간 도착정보 일괄제공 API)
//
// ⚠️ 서울열린데이터광장 API는 일일 호출 한도(무료 키 기준 1000건)가 있어서
//   1) 같은 조회는 25초 동안 캐시에서 응답 (여러 사용자·반복 폴링 시 호출 수 절약)
//   2) API가 실패하면(한도 초과 등) 10분 이내의 마지막 성공 데이터를 대신 반환
const arrivalCache = new Map(); // key -> { arrivals, at }
const ARRIVAL_CACHE_TTL_MS = 25 * 1000;
const ARRIVAL_STALE_MAX_MS = 10 * 60 * 1000;

// ── 1호선 구로 분기 ───────────────────────────────────────────────
// 구로에서 경부선(수원 방면)과 경인선(인천 방면)으로 갈라집니다. 두 갈래 모두
// "하행"이라 상/하행만으로는 구분이 안 되므로, 경로가 지나는 역명으로 갈래를
// 판별하고, 반대 갈래의 종착역행 열차는 실시간 도착정보에서 제외합니다.
// (다른 노선/구간에 비슷한 분기가 생기면 이 배열에 그룹을 추가하면 됩니다.)
const BRANCH_GROUPS = [
  {
    // 경부선 방면 (구로 이남)
    markerStops: [
      "가산디지털단지", "금천구청", "석수", "관악", "안양", "명학", "금정",
      "군포", "당정", "의왕", "성균관대", "화서", "수원", "세류", "병점",
      "서동탄", "천안", "신창",
    ],
    termini: ["수원", "서동탄", "병점", "천안", "신창"],
  },
  {
    // 경인선 방면 (구로 이남)
    markerStops: [
      "구일", "개봉", "오류동", "온수", "역곡", "소사", "부천", "송내",
      "부평", "백운", "동암", "간석", "주안", "동인천", "인천",
    ],
    termini: ["부평", "동인천", "인천"],
  },
];

/** 현재 역이 분기 구간에 있고, 경로가 같은 분기 방향으로 진행할 때만 허용 종착역명을 반환합니다. */
function getBranchAllowedTermini(currentStation, pathStops) {
  for (const group of BRANCH_GROUPS) {
    if (group.markerStops.includes(currentStation)) {
      const pathGoesIntoBranch = group.markerStops.some((m) => m !== currentStation && pathStops.has(m));
      if (pathGoesIntoBranch) return group.termini;
      return [];
    }
  }
  return [];
}

app.get("/api/realtime-arrival", async (req, res) => {
  const { station, line } = req.query;
  if (!station) {
    return res.status(400).json({ ok: false, reason: "station 파라미터(역명)가 필요합니다." });
  }
  try {
    const { direction, directionStops: dsRaw } = req.query;
    const directionHints = [direction, ...(dsRaw ? dsRaw.split(",") : [])].filter(Boolean);
    const cacheKey = `${baseStationName(station)}|${line || ""}`;
    const cached = arrivalCache.get(cacheKey);
    const now = Date.now();

    let arrivals;
    if (cached && now - cached.at < ARRIVAL_CACHE_TTL_MS) {
      arrivals = cached.arrivals;
    } else {
      arrivals = await fetchRealtimeArrival(baseStationName(station), line || undefined);

      if (arrivals === null) {
        if (cached && now - cached.at < ARRIVAL_STALE_MAX_MS) {
          arrivals = cached.arrivals;
        } else {
          return res.json({ ok: false, station, arrivals: null, reason: "실시간 도착정보 API 호출 실패(일일 한도 초과 등)" });
        }
      } else {
        arrivalCache.set(cacheKey, { arrivals, at: now });
      }
    }

    // 방향 필터
    // ⚠️ 예전 방식(경로 상의 역명이 trainLineNm에 포함되면 매칭)은 1호선처럼
    //   한 방향(하행)에 종착역이 여러 개로 갈라지는 노선(인천/신창/서동탄/구로 등)에서
    //   문제가 됐습니다. trainLineNm(예: "인천행 - 노량진방면 급행열차")에는 그 열차의
    //   "종착역"과 "다음 정차역"만 들어있어서, 목적지행이 아닌데도 경로상 먼 역명
    //   (예: 최종 목적지가 인천일 때의 "인천")과 우연히 일치하는 열차만 남고,
    //   같은 방향으로 가지만 종착역이 다른 열차(서동탄행, 신창행, 구로행 등)는
    //   전부 걸러져 버렸습니다.
    //
    // ✅ 수정: 먼저 "바로 다음 역명(direction)"이 trainLineNm에 포함된 열차를 찾아
    //   그 열차(들)의 상/하행 방향(updnLine)을 확인합니다. 목적지와 상관없이
    //   "같은 상/하행 방향"인 열차는 전부 포함시켜, 분기되는 종착역도 모두 나오도록 합니다.
    //   (예: 용산 → 구로면 하행 전체 → 인천행/구로행/서동탄행/천안행/신창행/수원행 모두 표시)
    //   바로 다음 역명으로 방향을 못 찾으면(연결 편차 등) 기존 방식으로 폴백합니다.
    if (directionHints.length > 0 && arrivals.length > 0) {
      const nextStopHint = direction;
      const updnLineSet = new Set();
      if (nextStopHint) {
        for (const a of arrivals) {
          const desc = a.lineName || "";
          if (a.updnLine && desc.includes(nextStopHint)) updnLineSet.add(a.updnLine);
        }
      }

      let dirFiltered;
      if (updnLineSet.size > 0) {
        dirFiltered = arrivals.filter((a) => a.updnLine && updnLineSet.has(a.updnLine));
      } else {
        dirFiltered = arrivals.filter((a) => {
          const desc = a.lineName || "";
          return directionHints.some((hint) => desc.includes(hint));
        });
      }
      if (dirFiltered.length > 0) arrivals = dirFiltered;
    }

    // 갈래(분기) 필터: 경로가 특정 분기 구간을 지나면, 해당 분기의 종착역행 열차만 표시합니다.
    // (예: 경로에 가산디지털단지가 있으면 수원/서동탄/병점/천안/신창행만,
    //  구일이 있으면 부평/동인천/인천행만 표시)
    if (dsRaw && arrivals.length > 0) {
      const currentStation = baseStationName(station);
      const pathStops = new Set(dsRaw.split(","));
      const allowedTermini = getBranchAllowedTermini(currentStation, pathStops);
      if (allowedTermini.length > 0) {
        arrivals = arrivals.filter((a) => {
          const dest = a.destinationStation || "";
          return allowedTermini.some((t) => dest.includes(t) || t.includes(dest));
        });
      }
    }

    // 도착 시간 빠른 순으로 정렬
    arrivals.sort((a, b) => {
      const sa = a.remainingSeconds ?? 9999;
      const sb = b.remainingSeconds ?? 9999;
      return sa - sb;
    });

    res.json({ ok: true, station, mock: USE_MOCK, arrivals });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

/**
 * ODsay 경로 후보 하나(candidate)의 승하차·환승역에 실시간으로 이용 가능한
 * 엘리베이터 "또는" 휠체어리프트가 있는지 확인합니다. 둘 다 없으면 그 역을
 * blocked 목록에 담아 돌려줍니다(엘리베이터만 고장이어도 리프트가 있으면 통과).
 */
async function checkOdsayPathAccessible(candidate) {
  const checkpointNames = [...new Set(candidate.checkpoints.map((c) => baseStationName(candidate.stops[c.idx].name)))];
  const [elevatorMap, liftMap] = await Promise.all([
    fetchElevatorStatusAll(checkpointNames),
    fetchLiftStatusAll(checkpointNames),
  ]);
  const blocked = [];
  for (const cp of candidate.checkpoints) {
    const name = baseStationName(candidate.stops[cp.idx].name);
    const elevatorStatus = elevatorMap.get(name);
    const liftStatus = liftMap.get(name);
    const elevatorOk = !elevatorStatus || elevatorStatus.operational !== false;
    const liftOk = !liftStatus ? true : Boolean(liftStatus.installed) && liftStatus.operational !== false;
    if (!elevatorOk && !liftOk) blocked.push(name);
  }
  return blocked;
}

/** ODsay 경로 후보를 프론트엔드가 기대하는 응답 형태로 변환합니다. */
async function buildResponseFromOdsayPath(candidate) {
  const stopNames = [...new Set(candidate.stops.map((s) => baseStationName(s.name)))];
  const [elevatorMap, liftMap] = await Promise.all([
    fetchElevatorStatusAll(stopNames),
    fetchLiftStatusAll(stopNames),
  ]);
  const checkpointByIdx = new Map(candidate.checkpoints.map((c) => [c.idx, c]));

  const stops = await Promise.all(
    candidate.stops.map(async (s, idx) => {
      const name = baseStationName(s.name);
      const elevatorStatus = elevatorMap.get(name);
      const liftStatus = liftMap.get(name);
      const checkpoint = checkpointByIdx.get(idx);

      let quickExit = null;
      if (checkpoint) {
        const lineForLookup =
          idx === 0 ? candidate.segmentLineNames[0] : candidate.segmentLineNames[Math.min(idx - 1, candidate.segmentLineNames.length - 1)];
        const directionOptions = {};
        if (idx === 0 && candidate.stops.length > 1) {
          directionOptions.preferDirection = baseStationName(candidate.stops[1].name);
        }
        if (idx > 0) {
          directionOptions.excludeDirection = baseStationName(candidate.stops[idx - 1].name);
        }
        quickExit = await fetchQuickExitInfo(name, lineForLookup, directionOptions);
      }

      const isBoard = idx === 0;
      const isTransfer = Boolean(checkpoint && checkpoint.role === "transfer");

      let arrivalMeta = null;
      if (isBoard || isTransfer) {
        const lineForArrival = isBoard ? candidate.segmentLineNames[0] : checkpoint.toLine;
        const nextIdx = idx + 1;
        const nextStop = nextIdx < candidate.stops.length ? baseStationName(candidate.stops[nextIdx].name) : undefined;
        const dirStops = [];
        for (let j = nextIdx; j < candidate.stops.length && dirStops.length < 15; j++) {
          const sn = baseStationName(candidate.stops[j].name);
          if (sn !== name) dirStops.push(sn);
        }
        arrivalMeta = { line: lineForArrival, direction: nextStop, directionStops: dirStops };
      }

      const lineForColor = idx === 0
        ? candidate.segmentLineNames[0]
        : candidate.segmentLineNames[Math.min(idx - 1, candidate.segmentLineNames.length - 1)];

      return {
        id: null,
        name: s.name,
        lineName: lineForColor,
        lat: s.lat,
        lng: s.lng,
        arrivalMeta,
        elevator: {
          installed: elevatorStatus ? true : null,
          operational: elevatorStatus ? elevatorStatus.operational !== false : null,
        },
        lift: {
          installed: liftStatus ? Boolean(liftStatus.installed) : null,
          operational: liftStatus ? liftStatus.operational !== false : null,
        },
        isTransfer: Boolean(checkpoint && checkpoint.role === "transfer"),
        quickExit,
      };
    })
  );

  const transfers = candidate.checkpoints
    .filter((c) => c.role === "transfer")
    .map((c) => ({ stationId: null, stationName: candidate.stops[c.idx].name, fromLine: c.fromLine, toLine: c.toLine }));

  return {
    ok: true,
    totalStops: stops.length - 1,
    estimatedMinutes: Math.round(candidate.totalTimeMinutes),
    transfers,
    segmentLines: candidate.segmentLineNames,
    stops,
  };
}

// 배리어프리 경로 탐색
//
// 우선순위:
//   1) ODsay 대중교통 경로 API로 "실제로 존재하는" 지하철 경로 후보들을 받아온다.
//      (내부에 손으로 입력해둔 제한적인 역·구간 데이터에 갇히지 않아서, 기존
//      방식이 크게 돌아가던 문제가 해결됩니다.)
//   2) 후보를 소요시간이 짧은 순서로 확인하면서, 승차/환승/하차역 중 엘리베이터가
//      지금 고장이거나 없는 역이 있으면 그 후보는 건너뛰고 다음 후보를 시도합니다.
//   3) ODsay 키가 없거나, API 호출이 실패하거나, 모든 후보가 막혀 있으면 내부
//      그래프 BFS(기존 방식)로 폴백합니다.
app.get("/api/route", async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ ok: false, reason: "start, end 파라미터(역 id)가 필요합니다." });
  }

  const startStation = stationById.get(start);
  const endStation = stationById.get(end);
  if (!startStation) return res.status(400).json({ ok: false, reason: "출발역을 찾을 수 없습니다." });
  if (!endStation) return res.status(400).json({ ok: false, reason: "도착역을 찾을 수 없습니다." });

  let blockedAcrossAttempts = [];

  if (odsayApi.ODSAY_AVAILABLE) {
    try {
      const candidates = await odsayApi.searchSubwayOnlyPaths({
        startLng: startStation.lng,
        startLat: startStation.lat,
        endLng: endStation.lng,
        endLat: endStation.lat,
      });

      for (const candidate of candidates.slice(0, 5)) {
        const blocked = await checkOdsayPathAccessible(candidate);
        if (blocked.length === 0) {
          const payload = await buildResponseFromOdsayPath(candidate);
          payload.source = "odsay";
          if (blockedAcrossAttempts.length > 0) {
            payload.note = `${[...new Set(blockedAcrossAttempts)].join(", ")} 역에 지금 이용 가능한 엘리베이터가 없어 다른 경로로 안내합니다.`;
          }
          return res.json(payload);
        }
        blockedAcrossAttempts.push(...blocked);
      }

      if (candidates.length === 0) {
        console.warn("[server] ODsay가 지하철로만 이루어진 경로 후보를 주지 않았습니다. 내부 그래프로 폴백합니다.");
      } else {
        console.warn(
          `[server] ODsay 경로 후보(${candidates.length}개) 모두 엘리베이터 문제로 막혔습니다: ${[...new Set(blockedAcrossAttempts)].join(
            ", "
          )}. 내부 그래프로 폴백합니다.`
        );
      }
    } catch (err) {
      console.error("[server] ODsay 경로 조회 실패, 내부 그래프로 폴백합니다:", err.message);
    }
  }

  // ── 폴백: 내부 그래프 BFS (손으로 입력한 제한된 역/구간 데이터 기반) ──
  const cache = elevatorStatusCache.getFullCache();
  const liftCache = elevatorStatusCache.getFullLiftCache();
  const result = findBarrierFreeRoute(start, end, cache, liftCache);

  if (!result.ok) {
    if (blockedAcrossAttempts.length > 0) {
      result.reason = `${result.reason} (ODsay로 찾은 경로들도 ${[...new Set(blockedAcrossAttempts)].join(
        ", "
      )} 역의 엘리베이터 문제로 이용할 수 없었습니다.)`;
    }
    return res.status(200).json(result);
  }

  // 경로 상의 각 역에 대해 "가장 가까운 엘리베이터 탑승 위치" 안내 부착
  // 출발역·환승역·도착역은 전부 "타고 내리는" 지점이라 모두 조회합니다.
  const keyStationIndexes = new Set([0, result.path.length - 1]);
  for (const t of result.transfers) {
    keyStationIndexes.add(result.path.indexOf(t.stationId));
  }

  const stops = await Promise.all(
    result.path.map(async (stationId, idx) => {
      const station = stationById.get(stationId);
      const live = cache.get(stationId);
      const liveLift = liftCache.get(stationId);
      const isKeyStop = keyStationIndexes.has(idx);
      let quickExit = null;
      if (isKeyStop) {
        const lineForLookup =
          idx === 0
            ? result.segmentLines[0]
            : idx === result.path.length - 1
            ? result.segmentLines[result.segmentLines.length - 1]
            : result.segmentLines[idx - 1];

        // 열차 진행 방향에 맞는 승강장 쪽 정보를 고르기 위한 힌트:
        // - 출발역: 다음 역 이름을 "선호 방향"으로 전달 (그쪽으로 가는 항목 우선)
        // - 환승역·도착역: 직전 역 이름을 "제외 방향"으로 전달 (반대 방향, 즉
        //   방금 타고 온 방향은 배제 — "지금 내린 열차 기준" 안내가 되도록)
        const directionOptions = {};
        if (idx === 0 && result.path.length > 1) {
          directionOptions.preferDirection = baseStationName(getStationName(result.path[1]));
        }
        if (idx > 0) {
          directionOptions.excludeDirection = baseStationName(getStationName(result.path[idx - 1]));
        }

        quickExit = await fetchQuickExitInfo(baseStationName(station.name), getLineLabel(lineForLookup), directionOptions);
      }

      const isBoard = idx === 0;
      const isTransferStop = result.transfers.some((t) => t.stationId === stationId);

      let arrivalMeta = null;
      if (isBoard || isTransferStop) {
        const lineForArrival = isBoard
          ? getLineLabel(result.segmentLines[0])
          : getLineLabel(result.segmentLines[idx]);
        const nextIdx = idx + 1;
        const nextStopHint = nextIdx < result.path.length ? baseStationName(getStationName(result.path[nextIdx])) : undefined;
        const dirStops = [];
        for (let j = nextIdx; j < result.path.length && dirStops.length < 15; j++) {
          const sn = baseStationName(getStationName(result.path[j]));
          if (sn !== baseStationName(station.name)) dirStops.push(sn);
        }
        arrivalMeta = { line: lineForArrival, direction: nextStopHint, directionStops: dirStops };
      }

      const lineForLabel = isBoard
        ? getLineLabel(result.segmentLines[0])
        : idx === result.path.length - 1
        ? getLineLabel(result.segmentLines[result.segmentLines.length - 1])
        : getLineLabel(result.segmentLines[idx - 1] || result.segmentLines[0]);

      return {
        id: stationId,
        name: station.name,
        lineName: lineForLabel,
        lat: station.lat,
        lng: station.lng,
        arrivalMeta,
        elevator: {
          installed: station.hasElevatorInstalled,
          operational: station.hasElevatorInstalled ? live?.operational !== false : false,
        },
        lift: {
          installed: Boolean(liveLift?.installed),
          operational: liveLift?.installed ? liveLift?.operational !== false : false,
        },
        isTransfer: result.transfers.some((t) => t.stationId === stationId),
        quickExit,
      };
    })
  );

  const mergedStops = [];
  for (const stop of stops) {
    const prev = mergedStops[mergedStops.length - 1];
    if (prev && baseStationName(prev.name) === baseStationName(stop.name)) {
      if (stop.isTransfer) prev.isTransfer = true;
      if (stop.realtimeArrival && stop.realtimeArrival.length > 0) prev.realtimeArrival = stop.realtimeArrival;
      if (stop.arrivalMeta) prev.arrivalMeta = stop.arrivalMeta;
      if (stop.quickExit) prev.quickExit = stop.quickExit;
      if (stop.elevator?.installed) prev.elevator = stop.elevator;
      if (stop.lift?.installed) prev.lift = stop.lift;
    } else {
      mergedStops.push({ ...stop });
    }
  }

  const MINUTES_PER_SEGMENT = 2;
  const MINUTES_PER_TRANSFER = 4;
  const estimatedMinutes =
    Math.max(0, result.path.length - 1) * MINUTES_PER_SEGMENT + result.transfers.length * MINUTES_PER_TRANSFER;

  res.json({
    ok: true,
    totalStops: result.totalStops,
    estimatedMinutes,
    transfers: result.transfers.map((t) => ({
      stationId: t.stationId,
      stationName: getStationName(t.stationId),
      fromLine: getLineLabel(t.fromLine),
      toLine: getLineLabel(t.toLine),
    })),
    segmentLines: result.segmentLines.map(getLineLabel),
    stops: mergedStops,
    source: "internal-graph-fallback",
    note:
      blockedAcrossAttempts.length > 0
        ? `${[...new Set(blockedAcrossAttempts)].join(", ")} 역의 엘리베이터 문제로 ODsay 실제 경로 대신, 내부에 등록된 제한적인 역 데이터 기준 경로로 안내합니다.`
        : odsayApi.ODSAY_AVAILABLE
        ? undefined
        : "ODSAY_API_KEY가 설정되지 않아 내부에 등록된 제한적인 역 데이터 기준 경로로 안내합니다. .env에 ODSAY_API_KEY를 넣으면 실제 대중교통 경로를 기준으로 안내합니다.",
  });
});

// 시연/발표용: 특정 역 엘리베이터를 강제로 "고장" 상태로 전환 (mock 모드에서만 동작)
app.post("/api/mock/set-broken", (req, res) => {
  if (!USE_MOCK) {
    return res.status(400).json({ ok: false, reason: "실제 API 연동 모드에서는 사용할 수 없습니다." });
  }
  const { stationName, broken } = req.body || {};
  if (!stationName) return res.status(400).json({ ok: false, reason: "stationName이 필요합니다." });
  setMockBrokenStation(stationName, !!broken);
  elevatorStatusCache
    .refresh()
    .then(() => res.json({ ok: true }))
    .catch((err) => res.status(500).json({ ok: false, reason: err.message }));
});

const PORT = Number(process.env.PORT || 3000);

// Vercel은 상시 실행 서버가 아니라 "요청이 올 때마다 실행되는 서버리스
// 함수" 구조라서, app.listen()을 부르면 안 되고 대신 app을 그대로
// export해서 Vercel이 요청마다 이 app으로 라우팅하게 해야 합니다.
// (로컬/일반 서버 환경에서는 지금처럼 npm start로 계속 띄워두면 됩니다.)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`배리어프리 환승 경로 서버 실행 중: http://localhost:${PORT}`);
    console.log(USE_MOCK ? "→ 목(mock) 엘리베이터 데이터 사용 중 (.env에서 USE_MOCK_ELEVATOR_API=false로 전환 가능)" : "→ 실제 공공데이터 API 연동 중");
    elevatorStatusCache.startAutoRefresh();
  });
} else {
  // ⚠️ 서버리스에서는 setInterval이 함수 실행이 끝나면 함께 사라져서
  // 3분마다 자동 갱신되지 않습니다. 대신 각 요청 시점에 캐시가 비어있으면
  // (updatedAt === 0) 그 요청 안에서 한 번 갱신하도록 처리합니다.
  elevatorStatusCache.refresh().catch((err) => console.error("[server] Vercel 초기 캐시 갱신 실패:", err.message));
}

module.exports = app;