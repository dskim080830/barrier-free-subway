/**
 * 역간 간선(edge) 데이터
 * ------------------------------------------------------------------
 * from, to : data/stations.js 의 station id
 * line     : 이 구간이 속한 호선 (LINE_META 키)
 *
 * ⚠️ 원칙: "실제로 바로 옆 역인지 확신할 수 있는 구간"만 등록했습니다.
 * 중간 역을 생략한 채 먼 역끼리 직접 연결하면 BFS 결과(최소 정차역 수)가
 * 왜곡되므로, 확신이 없는 구간은 일부러 비워 두었고 대신 README에
 * "전체 수도권으로 확장하기" 절차를 안내합니다.
 * (2호선은 순환선 전 구간을 정확한 실제 순서로 모두 수록했습니다.)
 */

const LINE2_LOOP = [
  "st_cityhall", "st_euljiro1", "st_euljiro3", "st_euljiro4", "st_dongdaemunhp",
  "st_sindang", "st_sangwangsimni", "st_wangsimni", "st_hanyangu", "st_ttukseom",
  "st_seongsu", "st_konkuk", "st_guui", "st_gangbyeon", "st_jamsilnaru", "st_jamsil",
  "st_jamsilsaenae", "st_sportscomplex", "st_samsung", "st_seolleung", "st_yeoksam",
  "st_gangnam", "st_gyodae", "st_seocho", "st_bangbae", "st_sadang", "st_nakseongdae",
  "st_seoulnatl", "st_bongcheon", "st_sillim", "st_sindaebang", "st_guro_digital",
  "st_daerim", "st_sindorim", "st_mullae", "st_yeongdeungpogu", "st_dangsan",
  "st_hapjeong", "st_hongikuniv", "st_sinchon", "st_ewha", "st_ahyeon", "st_chungjeongno",
];

function loopEdges(stationIds, line) {
  const edges = [];
  for (let i = 0; i < stationIds.length; i++) {
    const from = stationIds[i];
    const to = stationIds[(i + 1) % stationIds.length];
    edges.push({ from, to, line });
  }
  return edges;
}

const EDGES = [
  ...loopEdges(LINE2_LOOP, 2),

  // 1호선 도심 구간 (확인된 인접 구간)
  { from: "st_seoul_station", to: "st_cityhall", line: 1 },
  { from: "st_cityhall", to: "st_jonggak", line: 1 },
  { from: "st_jonggak", to: "st_jongno3", line: 1 },
  { from: "st_jongno3", to: "st_dongdaemun", line: 1 },
  { from: "st_seoul_station", to: "st_namyeong", line: 1 },
  { from: "st_namyeong", to: "st_yongsan", line: 1 },
  { from: "st_sindorim", to: "st_guro", line: 1 },
  { from: "st_guro", to: "st_gasan_digital", line: 1 },

  // 3호선
  { from: "st_gyeongbokgung", to: "st_anguk", line: 3 },
  { from: "st_anguk", to: "st_jongno3", line: 3 },

  // 4호선
  { from: "st_hyehwa", to: "st_dongdaemun", line: 4 },
  { from: "st_dongdaemun", to: "st_dongdaemunhp", line: 4 },
  { from: "st_sadang", to: "st_isu", line: 4 },

  // 5호선
  { from: "st_gwanghwamun", to: "st_jongno3", line: 5 },
  { from: "st_jongno3", to: "st_euljiro4", line: 5 },
  { from: "st_euljiro4", to: "st_dongdaemunhp", line: 5 },
  { from: "st_yeouido", to: "st_yeouinaru", line: 5 },

  // 6・7・8・9호선, 신분당선, 공항철도, 경의중앙선, 수인분당선은
  // 이번 시연 데이터에서는 다른 노선과의 "환승역(같은 노드)" 형태로만
  // 연결되어 있고, 같은 호선 역끼리의 직접 인접 구간은 확신할 수 있는
  // 만큼만 넣었습니다(현재는 없음). scripts/import_stations.js 로
  // 공식 CSV를 불러오면 자동으로 채워집니다.
];

module.exports = { EDGES, LINE2_LOOP };
