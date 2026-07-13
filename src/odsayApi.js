/**
 * ODsay 대중교통 길찾기 API 연동 모듈
 * ------------------------------------------------------------------
 * ⚠️ 왜 "카카오맵 API"가 아니라 ODsay인가?
 * 카카오맵은 지도 위에 보여주는 길찾기(자동차/도보/자전거) REST API는
 * 공개하지만, "지하철 역-역 대중교통 경로(환승 포함)"를 계산해주는 공개
 * REST API는 제공하지 않습니다 (모바일/웹 지도 앱 UI 안에서만 제공).
 * 대신 국내에서 지하철·버스 "대중교통 경로 탐색"용으로 가장 널리 쓰이는
 * 공개 REST API가 ODsay(오디세이) 입니다. 무료 등급으로도 하루 1,000건
 * 정도 호출이 가능해 이런 프로젝트에 적합합니다.
 *   - 발급: https://lab.odsay.com (회원가입 → API 신청 → apiKey 발급)
 *   - 문서: https://lab.odsay.com/guide/guide#searchPubTransPathT
 *
 * 이 모듈이 하는 일:
 *   1) 출발/도착 좌표(위경도)로 ODsay "대중교통 경로 조회"를 호출해서
 *      실제로 존재하는 최단/최소환승 경로 후보를 여러 개 받아옵니다.
 *   2) 그 중 "지하철로만" 이루어진 경로만 추려서(버스가 섞인 경로는
 *      이 프로젝트 범위가 아니므로 제외) 표준화된 형태로 반환합니다.
 *   3) 실제 승하차/환승 역을 정확히 뽑아내서, 서버(server.js)가 그
 *      역들만 서울교통공사 엘리베이터 실시간 상태와 대조할 수 있게 합니다.
 *
 * ⚠️ 필드명 확인 필요: 아래 파싱 로직은 ODsay 공식 문서에 나온 응답
 * 구조(result.path[].subPath[].trafficType/passStopList.stations 등)를
 * 기준으로 작성했습니다. 실제 발급받은 키로 한 번 호출해보고, 콘솔에
 * 찍히는 [odsayApi][DEBUG] 로그의 실제 구조와 다르면 아래 파싱 부분만
 * 고치면 됩니다 (다른 모듈 건드릴 필요 없음).
 */

const axios = require("axios");

const ODSAY_API_KEY = process.env.ODSAY_API_KEY || "";
const ODSAY_BASE_URL = "https://api.odsay.com/v1/api/searchPubTransPathT";

// ODsay키가 없으면 이 모듈은 아예 사용하지 않고(server.js가 기존 내부
// BFS 그래프로 자동 폴백), 있으면 실제 API를 호출합니다.
const ODSAY_AVAILABLE = Boolean(ODSAY_API_KEY);

const TRAFFIC_TYPE = { SUBWAY: 1, BUS: 2, WALK: 3 };

/**
 * 출발/도착 좌표로 대중교통 경로 후보를 조회합니다.
 * @param {{ startLng:number, startLat:number, endLng:number, endLat:number }} coords
 * @returns {Promise<Array<NormalizedPath>>} 소요시간 오름차순으로 정렬된, "지하철로만"
 *          구성된 경로 후보 목록 (버스가 하나라도 섞인 경로는 제외)
 */
async function searchSubwayOnlyPaths({ startLng, startLat, endLng, endLat }) {
  if (!ODSAY_AVAILABLE) {
    throw new Error("ODSAY_API_KEY가 설정되어 있지 않습니다.");
  }

  const params = {
    apiKey: ODSAY_API_KEY,
    SX: startLng,
    SY: startLat,
    EX: endLng,
    EY: endLat,
    OPT: 0, // 0: 추천, 별도 가중치 없이 여러 후보를 받아서 우리가 직접 고름
    SearchPathType: 1, // ⚠️ 문서상 1이 "지하철" 우선 옵션. 실제 응답에 버스가 섞여
    // 나오는 경우를 대비해 아래 filterSubwayOnly()에서 한 번 더 걸러냅니다.
  };

  let data;
  try {
    const res = await axios.get(ODSAY_BASE_URL, { params, timeout: 8000, headers: {
        'Referer': 'https://bfsubway.vercel.app' 
      } });
    data = res.data;
  } catch (err) {
    if (err.response) {
      console.error(
        `[odsayApi][DEBUG] HTTP ${err.response.status} 응답 본문:`,
        JSON.stringify(err.response.data).slice(0, 800)
      );
    }
    throw new Error(`ODsay API 호출 실패: ${err.message}`);
  }

  if (data?.error) {
    // ⚠️ ODsay는 오류도 HTTP 200으로 내려주고 본문에 에러 정보를 담는데,
    // 실제 필드명이 문서와 다를 수 있어 원본을 통째로 로그로 남깁니다.
    // (아래에서 흔히 쓰이는 몇 가지 필드명 후보를 순서대로 시도합니다.)
    console.error("[odsayApi][DEBUG] error 원본 응답:", JSON.stringify(data));
    const err = data.error;
    if (typeof err === "string") {
      throw new Error(`ODsay API 오류: ${err}`);
    }
    const code = err.code ?? err.errorCode ?? err.returnCode ?? "?";
    const msg = err.msg ?? err.message ?? err.errorMsg ?? err.returnMsg ?? JSON.stringify(err);
    throw new Error(`ODsay API 오류: [${code}] ${msg}`);
  }

  const rawPaths = data?.result?.path;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    console.log("[odsayApi][DEBUG] 예상과 다른 응답 구조:", JSON.stringify(data).slice(0, 800));
    return [];
  }

  const normalized = rawPaths.map(normalizePath).filter((p) => p && p.checkpoints.length >= 2);

  normalized.sort((a, b) => a.totalTimeMinutes - b.totalTimeMinutes);
  return normalized;
}

// ODsay의 subwayCode → 호선명 매핑 (문서 기준, 1~9호선은 신뢰도 높음).
// lane[].name 필드가 비어있을 때의 최후 폴백으로만 사용합니다.
const SUBWAY_CODE_NAME = {
  1: "1호선", 2: "2호선", 3: "3호선", 4: "4호선", 5: "5호선",
  6: "6호선", 7: "7호선", 8: "8호선", 9: "9호선",
};

/** subPath 하나에서 호선명을 최대한 정확히 뽑아냅니다. */
function extractLineName(sp) {
  const lane = Array.isArray(sp.lane) ? sp.lane[0] : sp.lane;
  const candidates = [lane?.name, lane?.laneName, lane?.busNo];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  const byCode = SUBWAY_CODE_NAME[Number(lane?.subwayCode)];
  if (byCode) return byCode;

  // 여기까지 왔으면 실제 응답 구조가 예상과 달라서 호선명을 못 뽑은 것입니다.
  // 노선별 색상이 전부 같게 보이는 문제의 원인이 되므로, 원본을 로그로 남깁니다.
  console.warn("[odsayApi][DEBUG] 호선명을 찾지 못해 '지하철'로 대체합니다. subPath 원본:", JSON.stringify(sp).slice(0, 500));
  return "지하철";
}
function normalizePath(rawPath) {
  const rawSubPaths = rawPath?.subPath;
  if (!Array.isArray(rawSubPaths)) return null;

  const hasBus = rawSubPaths.some((sp) => Number(sp.trafficType) === TRAFFIC_TYPE.BUS);
  if (hasBus) return null;

  const subwaySubPaths = rawSubPaths.filter((sp) => Number(sp.trafficType) === TRAFFIC_TYPE.SUBWAY);
  if (subwaySubPaths.length === 0) return null;

  // 각 지하철 구간의 역 리스트를 순서대로 이어 붙여 "역 단위" 경로를 만듭니다.
  const stops = []; // { name, lat, lng, lineName, subPathIndex }
  const segmentLineNames = []; // stops[i] -> stops[i+1] 구간의 호선명, stops와 길이 1 차이

  subwaySubPaths.forEach((sp, subPathIdx) => {
    const lineName = extractLineName(sp);
    const stationList = sp.passStopList?.stations;

    const stationsInThisLeg =
      Array.isArray(stationList) && stationList.length > 0
        ? stationList.map((st) => ({
            name: st.stationName,
            lat: Number(st.y ?? st.Y),
            lng: Number(st.x ?? st.X),
          }))
        : [
            { name: sp.startName, lat: Number(sp.startY), lng: Number(sp.startX) },
            { name: sp.endName, lat: Number(sp.endY), lng: Number(sp.endX) },
          ];

    for (let i = 0; i < stationsInThisLeg.length; i++) {
      const st = stationsInThisLeg[i];
      const isFirstOfLeg = i === 0;

      // 환승 경계: 이전 지하철 구간의 마지막 역 == 이번 구간의 첫 역인 경우가
      // 보통이라, 중복으로 두 번 넣지 않고 하나로 합칩니다.
      if (isFirstOfLeg && stops.length > 0 && stops[stops.length - 1].name === st.name) {
        // 이미 넣은 역이므로 건너뜀 (호선만 이번 구간 것으로 갱신은 하지 않음 —
        // 환승역은 fromLine/toLine을 segmentLineNames로 계산하기 때문에 문제 없음)
        continue;
      }

      stops.push({ name: st.name, lat: st.lat, lng: st.lng, subPathIndex: subPathIdx });
      if (stops.length > 1) segmentLineNames.push(lineName);
    }
  });

  if (stops.length < 2) return null;

  // 체크포인트: 승차역(0), 환승역(호선이 바뀌는 지점), 하차역(마지막)
  const checkpoints = [{ idx: 0, role: "board" }];
  for (let i = 1; i < segmentLineNames.length; i++) {
    if (segmentLineNames[i] !== segmentLineNames[i - 1]) {
      checkpoints.push({ idx: i, role: "transfer", fromLine: segmentLineNames[i - 1], toLine: segmentLineNames[i] });
    }
  }
  checkpoints.push({ idx: stops.length - 1, role: "alight" });

  return {
    totalTimeMinutes: Number(rawPath?.info?.totalTime) || estimateMinutes(stops.length, checkpoints.length - 2),
    stops,
    segmentLineNames,
    checkpoints,
  };
}

function estimateMinutes(stopCount, transferCount) {
  return Math.max(0, stopCount - 1) * 2 + Math.max(0, transferCount) * 4;
}

module.exports = {
  ODSAY_AVAILABLE,
  searchSubwayOnlyPaths,
};
