/**
 * 서울교통공사 / 서울열린데이터광장 공공데이터 연동 모듈
 * ------------------------------------------------------------------
 * 사용하는 데이터셋:
 *
 * 1) 서울시 빠른하차정보 현황 (getFstExit)
 *    http://openapi.seoul.go.kr:8088/{인증키}/xml|json/getFstExit/시작/끝/
 *    - 엘리베이터/계단과 가장 가까운 승하차 칸·문 위치 안내
 *
 * 2) 서울교통공사_휠체어리프트 설치현황 (mtrWheelLift)
 *    http://openapi.seoul.go.kr:8088/{인증키}/xml|json/mtrWheelLift/시작/끝/
 *    - 역별 휠체어리프트 설치 위치 및 상태
 *
 * 3) 서울시 지하철 실시간 도착정보(일괄제공) (realtimeStationArrival)
 *    http://swopenAPI.seoul.go.kr/api/subway/{인증키}/xml|json/realtimeStationArrival/0/{n}/{역명 or ALL}
 *    - 특정 역(또는 전체)의 실시간 열차 도착 정보
 *
 * 서울열린데이터광장 API는 data.go.kr과 요청 방식이 다릅니다: 쿼리스트링이
 * 아니라 "http://호스트/{인증키}/{json|xml}/{서비스명}/{시작}/{끝}/(선택:추가경로)"
 * 형태로 URL 경로에 전부 들어있습니다. 역 이름으로 필터링하는 파라미터가
 * 없는 서비스(getFstExit, mtrWheelLift)는 전체 데이터를 페이지 단위로 받아온
 * 뒤 우리 쪽에서 역 이름으로 걸러야 하고, realtimeStationArrival처럼 역명을
 * URL 경로 맨 뒤에 붙여서 바로 필터링해주는 서비스도 있습니다.
 *
 * ⚠️ 아래 필드명 중 "추정"이라고 표시된 것은 실제 서비스키로 최초 호출 시
 * 콘솔에 찍히는 [DEBUG] 로그(첫 row 전체 필드)를 보고 필요하면 고쳐주세요.
 */

// ── 공통: data.go.kr (공공데이터포털) 기반 폴백 엔드포인트 ──────────────
const BASE = {
  facility: process.env.FACILITY_API_URL || "https://apis.data.go.kr/B553766/facility/getFcElvtr",
  lift: process.env.LIFT_API_URL || "https://apis.data.go.kr/B553766/facility/getFcLift",
  quickExit: process.env.QUICK_EXIT_API_URL || "https://apis.data.go.kr/B553766/inout/getFstExit",
};

const FIELD_MAP = {
  facility: {
    stationName: "stnNm",
    lineName: "lineNm",
    facilityType: "fcltNm",
    operational: "operStts",
  },
  quickExit: {
    stationName: "stnNm",
    lineName: "lineNm",
    doorField: "qckgffVhclDoorNo",
    targetFacility: "plfmCmgFac",
    direction: "drtnInfo",
  },
};

/** "7-1" 형태의 문자열을 { carNumber: "7", doorNumber: "1" }로 분리 */
function parseCarDoor(doorStr) {
  if (!doorStr) return { carNumber: null, doorNumber: null };
  const [car, door] = String(doorStr).split("-");
  return { carNumber: car ?? null, doorNumber: door ?? null };
}

const USE_MOCK = String(process.env.USE_MOCK_ELEVATOR_API || "true") === "true";
const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || "";

// ── 서울열린데이터광장 (data.seoul.go.kr) 공통 설정 ──────────────────────
// 기존 엘리베이터 가동현황 조회용 키 (SeoulMetroFaciInfo)
const SEOUL_API_KEY = process.env.SEOUL_API_KEY || process.env.SEOUL_OPEN_DATA_API_KEY || "";
const SEOUL_BASE_URL = "http://openapi.seoul.go.kr:8088";
const SEOUL_FACILITY_SERVICE = "SeoulMetroFaciInfo";
const SEOUL_PAGE_SIZE = 1000; // 서울열린데이터광장은 보통 한 번에 최대 1000건

// 빠른하차정보 (getFstExit) 전용 키/서비스명
const QUICK_EXIT_SEOUL_API_KEY = process.env.SEOUL_QUICK_EXIT_API_KEY || "684f6e794464736b373965644b4e5a";
const QUICK_EXIT_SEOUL_SERVICE = "getFstExit";

// 휠체어리프트 설치현황 (mtrWheelLift) 전용 키/서비스명
const LIFT_SEOUL_API_KEY = process.env.SEOUL_LIFT_API_KEY || "665863466364736b3833496a517166";
const LIFT_SEOUL_SERVICE = "mtrWheelLift";

// 지하철 실시간 도착정보 (realtimeStationArrival) 전용 키/호스트
// ⚠️ 이 API는 8088 포트가 아니라 별도 호스트(swopenAPI.seoul.go.kr)를 씁니다.
const REALTIME_ARRIVAL_API_KEY = process.env.SEOUL_REALTIME_ARRIVAL_API_KEY || "446d4e786b64736b3631746a697164";
const REALTIME_ARRIVAL_BASE_URL = "http://swopenAPI.seoul.go.kr/api/subway";
const REALTIME_ARRIVAL_SERVICE = "realtimeStationArrival";

// ✅ 2026-07 실제 응답으로 확인된 필드명 (SeoulMetroFaciInfo):
// { STN_CD, STN_NM, ELVTR_NM, OPR_SEC, INSTL_PSTN, USE_YN, ELVTR_SE }
const SEOUL_FIELD_MAP = {
  stationName: "STN_NM",
  facilityType: "ELVTR_NM",
  operational: "USE_YN",
};

// ⚠️ 추정 필드명: getFstExit(빠른하차정보) 응답 구조가 확인되면 이 맵만 고치면 됩니다.
// data.go.kr 버전(FIELD_MAP.quickExit)과 동일한 의미의 필드를 서울열린데이터광장
// 명명 규칙(대문자 스네이크케이스)으로 추정해두었습니다.
const QUICK_EXIT_SEOUL_FIELD_MAP = {
  stationName: "STN_NM", // 역명
  lineName: "LINE_NM", // 호선명
  doorField: "CAR_DOOR_NO", // "칸-문" 형식 추정 (예: "7-1")
  targetFacility: "FAC_NM", // "엘리베이터" / "계단" 등 편의시설명
  direction: "DRCT_NM", // 하차 후 진행 방면
};

// ⚠️ 추정 필드명: mtrWheelLift(휠체어리프트 설치현황) 응답 구조가 확인되면 이 맵만 고치면 됩니다.
const LIFT_SEOUL_FIELD_MAP = {
  stationName: "STN_NM", // 역명
  lineName: "LINE_NM", // 호선명
  installPosition: "INSTL_PSTN", // 설치 위치
  operational: "USE_YN", // 가동상태 ("사용가능"이면 정상, 값 없으면 설치 자체를 "정상"으로 간주)
};

/**
 * 서울열린데이터광장 공통 호출 함수.
 * @param {string} baseUrl - 호스트 (포트 포함)
 * @param {string} apiKey - 인증키
 * @param {string} serviceName - 서비스명 (예: SeoulMetroFaciInfo, getFstExit, mtrWheelLift)
 * @param {number|string} startIndex
 * @param {number|string} endIndex
 * @param {string[]} extraPathSegments - 서비스명/시작/끝 뒤에 추가로 붙는 경로 (예: 역명)
 */
async function callSeoulOpenApiRaw(baseUrl, apiKey, serviceName, startIndex, endIndex, extraPathSegments = []) {
  const extra = extraPathSegments.filter(Boolean).map(encodeURIComponent).join("/");
  const url = `${baseUrl}/${apiKey}/json/${serviceName}/${startIndex}/${endIndex}/${extra ? extra + "/" : ""}`;
  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) {
    console.error(`[seoulOpenApi][${serviceName}] HTTP ${res.status} 응답 본문(앞 1000자): ${text.slice(0, 1000)}`);
    throw new Error(`서울열린데이터광장 API(${serviceName}) 응답 오류: HTTP ${res.status}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error(`[seoulOpenApi][${serviceName}] JSON 파싱 실패, 응답 본문(앞 1000자): ${text.slice(0, 1000)}`);
    throw new Error(`서울열린데이터광장 API(${serviceName})가 JSON이 아닌 응답을 반환했습니다.`);
  }

  const root = data[serviceName];
  if (!root) {
    console.error(`[seoulOpenApi][${serviceName}] 예상치 못한 응답 구조: ${JSON.stringify(data).slice(0, 500)}`);
    throw new Error(`서울열린데이터광장 API(${serviceName}) 응답 구조가 예상과 다릅니다. (인증키/서비스명을 확인하세요)`);
  }

  const code = root.RESULT?.CODE;
  // INFO-200은 "해당하는 데이터가 없습니다"로, 에러가 아니라 빈 결과이므로 통과시킵니다.
  if (code && code !== "INFO-000" && code !== "INFO-200") {
    throw new Error(`서울열린데이터광장 API(${serviceName}) 오류: [${code}] ${root.RESULT?.MESSAGE}`);
  }

  return {
    totalCount: Number(root.list_total_count || 0),
    rows: root.row || [],
  };
}

/** 기존 엘리베이터 가동현황(SeoulMetroFaciInfo) 호출 (하위 호환용 래퍼) */
async function callSeoulOpenApi(startIndex, endIndex) {
  return callSeoulOpenApiRaw(SEOUL_BASE_URL, SEOUL_API_KEY, SEOUL_FACILITY_SERVICE, startIndex, endIndex);
}

/** 서울열린데이터광장에서 특정 서비스의 전체 행을 페이지 단위로 모두 받아옵니다. */
async function fetchAllSeoulRows(baseUrl, apiKey, serviceName) {
  const all = [];
  let start = 1;
  let totalCount = Infinity;
  let loggedSample = false;

  while (start <= totalCount) {
    const end = start + SEOUL_PAGE_SIZE - 1;
    const { totalCount: tc, rows } = await callSeoulOpenApiRaw(baseUrl, apiKey, serviceName, start, end);
    totalCount = tc;

    if (!loggedSample && rows.length > 0) {
      console.log(`[seoulOpenApi][DEBUG][${serviceName}] 첫 row 예시 (전체 필드 확인용):`, rows[0]);
      loggedSample = true;
    }

    all.push(...rows);
    if (rows.length === 0) break; // 안전장치: 빈 응답이면 중단
    start = end + 1;
  }

  return all;
}

async function fetchAllSeoulFacilityRows() {
  return fetchAllSeoulRows(SEOUL_BASE_URL, SEOUL_API_KEY, SEOUL_FACILITY_SERVICE);
}

/**
 * 서울열린데이터광장 데이터를 기준으로 요청한 역들의 편의시설(엘리베이터 등)
 * 가동상태를 계산합니다. (SeoulMetroFaciInfo 전용, 하위 호환용)
 */
async function fetchFacilityStatusAllSeoul(stationNames, facilityKeyword) {
  const rows = await fetchAllSeoulFacilityRows();
  const f = SEOUL_FIELD_MAP;

  const byStation = new Map();
  for (const row of rows) {
    const name = row[f.stationName];
    if (!name) continue;
    if (!byStation.has(name)) byStation.set(name, []);
    byStation.get(name).push(row);
  }

  const result = new Map();
  for (const stationName of stationNames) {
    const rowsForStation = byStation.get(stationName) || [];

    if (rowsForStation.length === 0) {
      const candidates = [...byStation.keys()].filter(
        (name) => name.includes(stationName) || stationName.includes(name)
      );
      console.warn(
        `[seoulOpenApi][Seoul] "${stationName}" 이름으로 데이터를 못 찾았습니다.` +
          (candidates.length > 0 ? ` 비슷한 이름 후보: ${candidates.join(", ")}` : " 비슷한 이름도 없습니다.")
      );
    }

    const matchedRecords = rowsForStation.filter((r) => String(r[f.facilityType] || "").includes(facilityKeyword));
    const broken = matchedRecords.filter((r) => !String(r[f.operational] || "").includes("사용가능"));

    result.set(stationName, {
      operational: matchedRecords.length > 0 ? broken.length < matchedRecords.length : false,
      brokenFacilities: broken.map((r) => r[f.facilityType]),
    });
  }
  return result;
}

/** 서울열린데이터광장 데이터를 기준으로 요청한 역들의 엘리베이터 가동상태를 계산합니다. */
async function fetchElevatorStatusAllSeoul(stationNames) {
  return fetchFacilityStatusAllSeoul(stationNames, "엘리베이터");
}

// ── 휠체어리프트 설치현황 (mtrWheelLift) 전용 조회 ────────────────────
let liftRowsCache = null; // 요청마다 전체를 새로 긁지 않도록 프로세스 내 캐시 (elevatorStatusCache가 주기적으로 refresh를 부르므로 여기선 단순 캐시로 충분)

async function fetchAllLiftRows() {
  if (liftRowsCache) return liftRowsCache;
  liftRowsCache = await fetchAllSeoulRows(SEOUL_BASE_URL, LIFT_SEOUL_API_KEY, LIFT_SEOUL_SERVICE);
  return liftRowsCache;
}

/**
 * mtrWheelLift(서울교통공사_휠체어리프트 설치현황) 데이터를 기준으로 요청한
 * 역들의 휠체어리프트 가동상태를 계산합니다. 이 데이터셋은 "설치현황"이라
 * 별도의 가동상태 필드가 없을 수 있어, 있으면 사용하고 없으면 "설치되어
 * 있으면 정상"으로 간주합니다.
 */
async function fetchLiftStatusAllSeoulNative(stationNames) {
  const rows = await fetchAllLiftRows();
  const f = LIFT_SEOUL_FIELD_MAP;

  const byStation = new Map();
  for (const row of rows) {
    const name = row[f.stationName];
    if (!name) continue;
    if (!byStation.has(name)) byStation.set(name, []);
    byStation.get(name).push(row);
  }

  const result = new Map();
  for (const stationName of stationNames) {
    const rowsForStation = byStation.get(stationName) || [];
    if (rowsForStation.length === 0) {
      const candidates = [...byStation.keys()].filter(
        (name) => name.includes(stationName) || stationName.includes(name)
      );
      console.warn(
        `[seoulOpenApi][mtrWheelLift] "${stationName}" 이름으로 리프트 데이터를 못 찾았습니다.` +
          (candidates.length > 0 ? ` 비슷한 이름 후보: ${candidates.join(", ")}` : " → 리프트 미설치로 간주합니다.")
      );
    }

    // 가동상태 필드가 실제로 존재하면(값이 있으면) "사용가능" 여부로 판단하고,
    // 필드 자체가 비어있으면(설치현황 데이터에는 없을 수 있음) 설치된 것만으로 정상 처리합니다.
    const broken = rowsForStation.filter((r) => {
      const val = r[f.operational];
      return val && !String(val).includes("사용가능");
    });

    result.set(stationName, {
      operational: rowsForStation.length > 0 ? broken.length < rowsForStation.length : false,
      brokenFacilities: broken.map((r) => r[f.installPosition] || "휠체어리프트"),
    });
  }
  return result;
}

/**
 * 특정 역의 "가장 가까운 승하차 위치(칸/문 번호)" 안내 정보를 서울열린데이터광장
 * getFstExit(빠른하차정보) 데이터에서 찾습니다. 이 서비스는 역명 필터 파라미터가
 * 없어서 전체 데이터를 한 번 받아온 뒤 메모리에서 필터링합니다.
 */
let quickExitRowsCache = null;

async function fetchAllQuickExitRows() {
  if (quickExitRowsCache) return quickExitRowsCache;
  quickExitRowsCache = await fetchAllSeoulRows(SEOUL_BASE_URL, QUICK_EXIT_SEOUL_API_KEY, QUICK_EXIT_SEOUL_SERVICE);
  return quickExitRowsCache;
}

async function fetchQuickExitInfoSeoul(stationName, lineLabel, { preferDirection, excludeDirection } = {}) {
  const rows = await fetchAllQuickExitRows();
  const f = QUICK_EXIT_SEOUL_FIELD_MAP;

  let items = rows.filter((r) => r[f.stationName] === stationName);
  if (items.length === 0) {
    items = rows.filter((r) => String(r[f.stationName] || "").includes(stationName) || stationName.includes(String(r[f.stationName] || "")));
  }
  if (lineLabel) {
    const byLine = items.filter((r) => String(r[f.lineName] || "").includes(lineLabel) || lineLabel.includes(String(r[f.lineName] || "")));
    if (byLine.length > 0) items = byLine;
  }

  if (items.length === 0) {
    console.warn(`[seoulOpenApi][getFstExit] "${stationName}"(${lineLabel}) 빠른하차정보를 못 찾았습니다.`);
    return null;
  }

  let facilityLabel = "엘리베이터";
  let records = items.filter((it) => String(it[f.targetFacility] || "").includes("엘리베이터"));
  if (records.length === 0) {
    facilityLabel = "휠체어리프트";
    records = items.filter((it) => String(it[f.targetFacility] || "").includes("리프트"));
  }
  if (records.length === 0) records = items; // 시설 구분 필드가 없으면 전체에서 고름

  let chosen = null;
  if (preferDirection) {
    chosen = records.find((it) => it[f.direction] === preferDirection);
  }
  if (!chosen && excludeDirection) {
    chosen = records.find((it) => it[f.direction] !== excludeDirection);
  }
  if (!chosen) chosen = records[0];

  const { carNumber, doorNumber } = parseCarDoor(chosen[f.doorField]);
  const direction = chosen[f.direction] ?? null;
  const icon = facilityLabel === "엘리베이터" ? "♿" : "🦽";

  return {
    facility: facilityLabel,
    carNumber,
    doorNumber,
    direction,
    note: `${lineLabel || ""} ${stationName} 하차 시${direction ? ` ${direction} 방면` : ""} ${carNumber ?? "?"}번째 칸 ${doorNumber ?? "?"}번 문 쪽이 ${icon} ${facilityLabel}와 가장 가깝습니다.`,
  };
}

// ── 지하철 실시간 도착정보 (realtimeStationArrival) ───────────────────
// ⚠️ 추정 필드명: 실제 응답 확인되면 여기만 고치면 됩니다. (Seoul Open API
// realtimeStationArrival 서비스의 공식 문서 기준 필드명입니다)
const REALTIME_ARRIVAL_FIELD_MAP = {
  lineName: "trainLineNm", // 예: "당고개행 - 신도림방면 일반열차"
  updnLine: "updnLine", // 상행/하행 구분
  arrivalMessage: "arvlMsg2", // 예: "전역 도착", "3분 후 (서울역)"
  currentStatusMessage: "arvlMsg3", // 예: "전역 도착", "진입"
  destinationStation: "bstatnNm", // 종착역
  trainStatus: "btrainSttus", // "일반", "급행" 등
  arrivalCode: "arvlCd", // 도착 코드
  updatedAt: "recptnDt", // 수신 시각
};

/**
 * 특정 역의 실시간 지하철 도착정보를 가져옵니다.
 * @param {string} stationName - 역명 (예: "강남")
 * @returns {Promise<Array<{lineName:string, updnLine:string, arrivalMessage:string, currentStatusMessage:string, destinationStation:string, trainStatus:string, updatedAt:string}>>}
 */
async function fetchRealtimeArrival(stationName) {
  if (!stationName) return [];
  if (USE_MOCK) return mockFetchRealtimeArrival(stationName);

  try {
    // 0~20번째까지 조회 (상/하행 여러 편성이 섞여 오므로 넉넉하게 받아둡니다)
    const { rows } = await callSeoulOpenApiRaw(
      REALTIME_ARRIVAL_BASE_URL,
      REALTIME_ARRIVAL_API_KEY,
      REALTIME_ARRIVAL_SERVICE,
      0,
      20,
      [stationName]
    );

    if (rows.length > 0) {
      console.log(`[seoulOpenApi][DEBUG][realtimeStationArrival] "${stationName}" 첫 row 예시:`, rows[0]);
    }

    const f = REALTIME_ARRIVAL_FIELD_MAP;
    return rows.map((r) => ({
      lineName: r[f.lineName] ?? null,
      updnLine: r[f.updnLine] ?? null,
      arrivalMessage: r[f.arrivalMessage] ?? null,
      currentStatusMessage: r[f.currentStatusMessage] ?? null,
      destinationStation: r[f.destinationStation] ?? null,
      trainStatus: r[f.trainStatus] ?? null,
      updatedAt: r[f.updatedAt] ?? null,
    }));
  } catch (err) {
    console.error(`[seoulOpenApi] "${stationName}" 실시간 도착정보 조회 실패:`, err.message);
    return [];
  }
}

/** 목(mock) 실시간 도착정보: API 키 없이도 데모용으로 그럴듯한 값을 만듭니다. */
async function mockFetchRealtimeArrival(stationName) {
  const minutesAhead = (stationName.length % 5) + 1;
  return [
    {
      lineName: "상행 · 일반열차",
      updnLine: "상행",
      arrivalMessage: `${minutesAhead}분 후 (${stationName} 도착)`,
      currentStatusMessage: minutesAhead <= 1 ? "전역 도착" : "운행 중",
      destinationStation: "종착역(mock)",
      trainStatus: "일반",
      updatedAt: new Date().toISOString(),
    },
    {
      lineName: "하행 · 일반열차",
      updnLine: "하행",
      arrivalMessage: `${minutesAhead + 2}분 후 (${stationName} 도착)`,
      currentStatusMessage: "운행 중",
      destinationStation: "종착역(mock)",
      trainStatus: "일반",
      updatedAt: new Date().toISOString(),
    },
  ];
}

// ── data.go.kr(공공데이터포털) 관련: XML 파서 + 호출 함수 (폴백용) ───────
function parseFlatXml(text) {
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].trim() : undefined;
  };

  const headerBlock = (text.match(/<header>([\s\S]*?)<\/header>/) || [])[1] || "";
  const resultCode = pick(headerBlock, "resultCode");
  const resultMsg = pick(headerBlock, "resultMsg");

  const itemBlocks = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const tagNameRe = /<([a-zA-Z0-9_]+)>/g;

  const items = itemBlocks.map((block) => {
    const obj = {};
    let tm;
    tagNameRe.lastIndex = 0;
    const seen = new Set();
    while ((tm = tagNameRe.exec(block))) {
      const tag = tm[1];
      if (seen.has(tag)) continue;
      seen.add(tag);
      obj[tag] = pick(block, tag);
    }
    return obj;
  });

  return {
    response: {
      header: { resultCode, resultMsg },
      body: { items },
    },
  };
}

async function callDataGoKrApi(baseUrl, params) {
  const query = new URLSearchParams();
  query.set("dataType", "JSON");
  for (const [k, v] of Object.entries(params)) query.set(k, v);

  const url = `${baseUrl}?serviceKey=${SERVICE_KEY}&${query.toString()}`;

  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) {
    console.error(`[seoulOpenApi] HTTP ${res.status} 응답 본문(앞 1000자): ${text.slice(0, 1000)}`);
    throw new Error(`공공데이터포털 API 응답 오류: HTTP ${res.status}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    if (text.trim().startsWith("<")) {
      data = parseFlatXml(text);
      console.log(`[seoulOpenApi][DEBUG] XML 응답 파싱됨. 첫 item 예시:`, data.response.body.items[0]);
    } else {
      console.error(`[seoulOpenApi] 알 수 없는 응답 형식(앞 1000자): ${text.slice(0, 1000)}`);
      throw new Error("공공데이터포털 API가 JSON도 XML도 아닌 응답을 반환했습니다.");
    }
  }

  const header = data?.response?.header;
  if (header && header.resultCode && header.resultCode !== "00") {
    throw new Error(`공공데이터포털 API 오류: [${header.resultCode}] ${header.resultMsg}`);
  }

  return data;
}

/**
 * 전체 역의 엘리베이터 실시간 가동 상태를 가져옵니다.
 * 반환: Map<stationName, { operational: boolean, brokenFacilities: string[] }>
 */
async function fetchElevatorStatusAll(stationNames) {
  if (USE_MOCK) return mockFetchElevatorStatusAll(stationNames);

  const result = new Map();
  for (const stationName of stationNames) {
    try {
      const data = await callDataGoKrApi(BASE.facility, {
        stnNm: stationName,
        numOfRows: 100,
        pageNo: 1,
      });
      const items = extractItems(data);
      const f = FIELD_MAP.facility;

      if (items.length === 0) {
        console.warn(`[seoulOpenApi][DEBUG] 엘리베이터 응답(${stationName})에 item이 0개입니다. (역명 불일치이거나 서비스키/파라미터 문제일 수 있음)`);
      }

      const elevatorRecords = items.filter((it) => String(it[f.facilityType] || "").includes("엘리베이터"));
      const broken = elevatorRecords.filter((it) => String(it[f.operational] || "").includes("고장"));

      result.set(stationName, {
        operational: elevatorRecords.length > 0 ? broken.length < elevatorRecords.length : false,
        brokenFacilities: broken.map((it) => it[f.facilityType]),
      });
    } catch (err) {
      console.error(`[seoulOpenApi] ${stationName} 엘리베이터 상태 조회 실패:`, err.message);
    }
  }
  return result;
}

/**
 * 전체 역의 휠체어리프트 실시간 가동 상태를 가져옵니다.
 * 우선순위: mtrWheelLift(서울열린데이터광장, 요청주신 전용 API) → data.go.kr 폴백
 */
async function fetchLiftStatusAll(stationNames) {
  if (USE_MOCK) return mockFetchLiftStatusAll(stationNames);

  try {
    return await fetchLiftStatusAllSeoulNative(stationNames);
  } catch (err) {
    console.error(`[seoulOpenApi][mtrWheelLift] 리프트 전체 조회 실패, data.go.kr로 폴백합니다:`, err.message);
  }

  const result = new Map();
  for (const stationName of stationNames) {
    try {
      const data = await callDataGoKrApi(BASE.lift, {
        stnNm: stationName,
        numOfRows: 100,
        pageNo: 1,
      });
      const items = extractItems(data);
      const f = FIELD_MAP.facility;

      const liftRecords = items.filter((it) => String(it[f.facilityType] || "").includes("리프트"));
      const broken = liftRecords.filter((it) => String(it[f.operational] || "").includes("고장"));

      result.set(stationName, {
        operational: liftRecords.length > 0 ? broken.length < liftRecords.length : false,
        brokenFacilities: broken.map((it) => it[f.facilityType]),
      });
    } catch (err) {
      console.error(`[seoulOpenApi] ${stationName} 휠체어리프트 상태 조회 실패:`, err.message);
    }
  }
  return result;
}

/**
 * 특정 역의 "가장 가까운 승하차 위치(칸/문 번호)" 안내 정보를 가져옵니다.
 * 우선순위: getFstExit(서울열린데이터광장, 요청주신 전용 API) → data.go.kr 폴백
 */
async function fetchQuickExitInfo(stationName, lineLabel, { preferDirection, excludeDirection } = {}) {
  if (USE_MOCK) return mockFetchQuickExitInfo(stationName, lineLabel);

  try {
    const info = await fetchQuickExitInfoSeoul(stationName, lineLabel, { preferDirection, excludeDirection });
    if (info) return info;
  } catch (err) {
    console.error(`[seoulOpenApi][getFstExit] ${stationName} 빠른하차정보 조회 실패, data.go.kr로 폴백합니다:`, err.message);
  }

  try {
    const data = await callDataGoKrApi(BASE.quickExit, {
      stnNm: stationName,
      lineNm: lineLabel,
      numOfRows: 20,
      pageNo: 1,
    });
    const items = extractItems(data);
    if (items.length === 0) {
      console.warn(`[seoulOpenApi][DEBUG] quickExit 응답(${stationName}/${lineLabel})에 item이 0개입니다.`);
    }
    const f = FIELD_MAP.quickExit;

    let facilityLabel = "엘리베이터";
    let records = items.filter((it) => String(it[f.targetFacility] || "").includes("엘리베이터"));
    if (records.length === 0) {
      facilityLabel = "휠체어리프트";
      records = items.filter((it) => String(it[f.targetFacility] || "").includes("리프트"));
    }
    if (records.length === 0) return null;

    let chosen = null;
    if (preferDirection) {
      chosen = records.find((it) => it[f.direction] === preferDirection);
    }
    if (!chosen && excludeDirection) {
      chosen = records.find((it) => it[f.direction] !== excludeDirection);
    }
    if (!chosen) chosen = records[0];

    const { carNumber, doorNumber } = parseCarDoor(chosen[f.doorField]);
    const direction = chosen[f.direction] ?? null;
    const icon = facilityLabel === "엘리베이터" ? "♿" : "🦽";

    return {
      facility: facilityLabel,
      carNumber,
      doorNumber,
      direction,
      note: `${lineLabel} ${stationName} 하차 시${direction ? ` ${direction} 방면` : ""} ${carNumber ?? "?"}번째 칸 ${doorNumber ?? "?"}번 문 쪽이 ${icon} ${facilityLabel}와 가장 가깝습니다.`,
    };
  } catch (err) {
    console.error(`[seoulOpenApi] ${stationName} 빠른하차정보 조회 실패:`, err.message);
    return null;
  }
}

/** 공공데이터포털 응답의 items 배열을 최대한 관대하게 추출 */
function extractItems(data) {
  const items = data?.response?.body?.items;
  if (Array.isArray(items)) return items;
  return (
    items?.item ||
    data?.body?.items ||
    data?.items ||
    []
  );
}

// ── 목(mock) 데이터: API 키가 없을 때 로컬 개발/발표 시연용 ─────────────
const MOCK_BROKEN_STATIONS = new Set();

async function mockFetchElevatorStatusAll(stationNames) {
  const result = new Map();
  for (const name of stationNames) {
    result.set(name, {
      operational: !MOCK_BROKEN_STATIONS.has(name),
      brokenFacilities: MOCK_BROKEN_STATIONS.has(name) ? ["1번 엘리베이터"] : [],
    });
  }
  return result;
}

async function mockFetchLiftStatusAll(stationNames) {
  const result = new Map();
  for (const name of stationNames) {
    result.set(name, { operational: true, brokenFacilities: [] });
  }
  return result;
}

async function mockFetchQuickExitInfo(stationName, lineLabel) {
  const carNumber = (stationName.length % 8) + 1;
  return {
    facility: "엘리베이터",
    carNumber,
    doorNumber: 2,
    note: `${lineLabel} ${stationName} 하차 시 ${carNumber}번째 칸 2번 문 쪽이 ♿ 엘리베이터와 가장 가깝습니다.`,
  };
}

function setMockBrokenStation(stationName, broken) {
  if (broken) MOCK_BROKEN_STATIONS.add(stationName);
  else MOCK_BROKEN_STATIONS.delete(stationName);
}

/** 서울열린데이터광장 전체 스캔 캐시(리프트/빠른하차)를 비웁니다. 상태 새로고침 시 호출하세요. */
function clearSeoulRawCaches() {
  liftRowsCache = null;
  quickExitRowsCache = null;
}

module.exports = {
  fetchElevatorStatusAll,
  fetchLiftStatusAll,
  fetchQuickExitInfo,
  fetchRealtimeArrival,
  setMockBrokenStation,
  clearSeoulRawCaches,
  USE_MOCK,
};
