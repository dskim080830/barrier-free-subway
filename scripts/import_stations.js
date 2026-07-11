/**
 * 전체 수도권 역 데이터로 확장하기
 * ------------------------------------------------------------------
 * 공공데이터포털에서 아래 파일을 내려받아 사용하세요.
 *   - "서울교통공사_노선별 지하철역 정보" (역명/호선/역코드)
 *   - 역별 위경도 좌표가 포함된 데이터셋(예: "전국 도시철도 역사 좌표 정보")
 * 두 데이터를 역명 기준으로 합친 CSV를 준비한 뒤 아래 형식으로 저장합니다.
 *
 *   line,order,stationName,lat,lng,hasElevatorInstalled,hasLiftInstalled
 *   2,1,시청,37.5658,126.9772,true,false
 *   2,2,을지로입구,37.5660,126.9827,true,false
 *   ...
 *
 * hasLiftInstalled 컬럼은 선택 사항입니다 (없으면 전부 false로 처리).
 * 엘리베이터가 없어도 휠체어 리프트가 설치된 역은 true로 표시하면
 * 배리어프리 경로 탐색에서 하차 가능한 역으로 인정됩니다.
 *
 * 실행:
 *   node scripts/import_stations.js ./내려받은파일.csv
 *
 * 결과: data/stations.generated.js, data/edges.generated.js 가 생성되고,
 * src/graph.js 가 기동 시 자동으로 기존 데이터와 합쳐서 불러옵니다.
 * (동일 역명은 하나의 노드로 자동 병합되어 환승역 처리가 됩니다.)
 */

const fs = require("fs");
const path = require("path");

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("사용법: node scripts/import_stations.js <csv경로>");
  process.exit(1);
}

const raw = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
const header = raw[0].split(",").map((h) => h.trim());
const rows = raw.slice(1).map((line) => {
  const cols = line.split(",");
  const obj = {};
  header.forEach((h, i) => (obj[h] = (cols[i] || "").trim()));
  return obj;
});

// 역명 기준으로 station 노드 병합
const stationsByName = new Map();
const edgesByLine = new Map();
const usedIds = new Set();

for (const row of rows) {
  const name = row.stationName;
  const line = isNaN(Number(row.line)) ? row.line : Number(row.line);

  if (!stationsByName.has(name)) {
    stationsByName.set(name, {
      id: makeUniqueId(name, usedIds),
      name,
      lines: [],
      lat: Number(row.lat) || 0,
      lng: Number(row.lng) || 0,
      hasElevatorInstalled: row.hasElevatorInstalled !== "false",
      // hasLiftInstalled: CSV에 이 컬럼이 없으면(구형 CSV 호환) 기본값 false.
      // 엘리베이터 없이 휠체어 리프트만 있는 역도 하차 가능하게 하려면
      // CSV에 hasLiftInstalled 컬럼을 추가하고 true로 표시하세요.
      hasLiftInstalled: row.hasLiftInstalled === "true",
    });
  }
  const station = stationsByName.get(name);
  if (!station.lines.includes(line)) station.lines.push(line);

  if (!edgesByLine.has(line)) edgesByLine.set(line, []);
  edgesByLine.get(line).push({ order: Number(row.order), name });
}

const stations = [...stationsByName.values()];

const edges = [];
for (const [line, list] of edgesByLine.entries()) {
  list.sort((a, b) => a.order - b.order);
  for (let i = 0; i < list.length - 1; i++) {
    edges.push({
      from: stationsByName.get(list[i].name).id,
      to: stationsByName.get(list[i + 1].name).id,
      line,
    });
  }
}

function slugify(name) {
  // ⚠️ 버그 수정: 예전엔 .normalize("NFKD")를 쓰고 있었는데, NFKD는 한글
  //   완성형 글자("철")를 자음/모음 낱자로 분해합니다. 그 낱자들은 아래
  //   정규식의 "가-힣"(완성형 한글 음절 범위) 밖이라 전부 걸러져서,
  //   모든 한글 역명이 빈 문자열이 되어 버렸습니다 (→ 전 역이 동일한 id
  //   "st_gen_"을 갖게 되는 심각한 버그의 원인). NFKD 정규화 자체를 빼서
  //   완성형 한글 글자가 그대로 유지되도록 고쳤습니다.
  return name
    .replace(/[^\w가-힣]/g, "")
    .toLowerCase();
}

/** slug가 비었거나 다른 역과 충돌하면 접미사를 붙여 고유 id를 보장합니다. */
function makeUniqueId(name, usedIds) {
  let base = "st_gen_" + slugify(name);
  if (base === "st_gen_") base = "st_gen_x"; // slug가 그래도 비는 극단적 케이스 대비
  let id = base;
  let n = 2;
  while (usedIds.has(id)) {
    id = `${base}_${n}`;
    n++;
  }
  usedIds.add(id);
  return id;
}

const outStations = `// 자동 생성 파일입니다. scripts/import_stations.js 로 재생성하세요.
module.exports.STATIONS_GENERATED = ${JSON.stringify(stations, null, 2)};
`;
const outEdges = `// 자동 생성 파일입니다. scripts/import_stations.js 로 재생성하세요.
module.exports.EDGES_GENERATED = ${JSON.stringify(edges, null, 2)};
`;

fs.writeFileSync(path.join(__dirname, "..", "data", "stations.generated.js"), outStations);
fs.writeFileSync(path.join(__dirname, "..", "data", "edges.generated.js"), outEdges);

console.log(`역 ${stations.length}개, 구간 ${edges.length}개 생성 완료.`);
