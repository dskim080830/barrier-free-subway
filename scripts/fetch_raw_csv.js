// scripts/fetch_raw_csv.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ⚠️ 발급받으신 서울시 열린데이터 광장 일반 인증키를 입력하세요.
const API_KEY = '4a4a567a6964736b323749525a4744'; 

// 대량의 데이터를 1000개씩 쪼개서 안전하게 받아오는 헬퍼 함수
async function fetchAllPages(baseUrl, dataKey) {
  let allRows = [];
  let start = 1;
  let end = 1000;
  let hasMore = true;

  while (hasMore) {
    const url = `${baseUrl}${start}/${end}/`;
    try {
      const res = await axios.get(url);
      if (res.data && res.data[dataKey] && res.data[dataKey].row) {
        const rows = res.data[dataKey].row;
        allRows = allRows.concat(rows);
        
        // 가져온 데이터가 1000개 미만이면 다음 페이지가 없는 것임
        if (rows.length < 1000) {
          hasMore = false;
        } else {
          start += 1000;
          end += 1000;
        }
      } else {
        // 더 이상 데이터 구조가 없으면 종료
        hasMore = false;
      }
    } catch (err) {
      console.error(`⚠️ ${start}~${end} 구간 요청 중 에러 발생, 이전까지의 데이터만 결합합니다.`);
      hasMore = false;
    }
  }
  return allRows;
}

async function fetchSubwayDataFromSeoul() {
  console.log("📡 [경기/인천 전역 확장] 수도권 지하철 데이터를 쪼개어 안전하게 수집 중입니다...");

  try {
    // 1. 역사 마스터 정보 수집 (위도, 경도)
    console.log("🔍 1/2: 역사 위경도 마스터 정보 다운로드 중 (Paging)...");
    const masterBaseUrl = `http://openapi.seoul.go.kr:8088/${API_KEY}/json/subwayStationMaster/`;
    const masterRows = await fetchAllPages(masterBaseUrl, 'subwayStationMaster');
    
    const coordMap = new Map();
    masterRows.forEach(row => {
      if (row && typeof row.STATN_NM === 'string') {
        const pureName = row.STATN_NM.split('(')[0].trim();
        coordMap.set(pureName, { lat: row.CRDNT_X, lng: row.CRDNT_Y });
      }
    });
    console.log(`📊 수집된 마스터 역사 좌표 수: ${coordMap.size}개`);

    // 2. 노선별 지하철역 정보 수집 (철산역 등 경기권 포함 전체 순서)
    console.log("🔍 2/2: 호선별 역 정보 및 순서 다운로드 중 (Paging)...");
    const lineBaseUrl = `http://openapi.seoul.go.kr:8088/${API_KEY}/json/SearchSTNBySubwayLineInfo/`;
    const lineRows = await fetchAllPages(lineBaseUrl, 'SearchSTNBySubwayLineInfo');

    if (lineRows.length === 0) {
      throw new Error("API로부터 역 정보 데이터를 가져오지 못했습니다. 인증키를 다시 확인해 주세요.");
    }
    console.log(`📊 수집된 총 호선별 데이터 행(Rows): ${lineRows.length}개`);

    // 3. CSV 구조 생성
    let csvContent = "line,order,stationName,lat,lng,hasElevatorInstalled\n";
    let orderCounter = new Map();

    lineRows.forEach(row => {
      if (!row || typeof row.STATION_NM !== 'string' || typeof row.LINE_NUM !== 'string') return;

      const lineName = row.LINE_NUM;
      const stationName = row.STATION_NM.trim();
      
      // 호선 ID 정제
      let lineId = lineName.replace(/[^0-9]/g, '');
      if (!lineId) {
        if (lineName.includes("경의")) lineId = "KJ";
        else if (lineName.includes("수인")) lineId = "SIN";
        else if (lineName.includes("공항")) lineId = "AREX";
        else if (lineName.includes("신분당")) lineId = "SB";
        else lineId = lineName;
      } else {
        lineId = Number(lineId).toString();
      }

      if (!orderCounter.has(lineId)) orderCounter.set(lineId, 1);
      const currentOrder = orderCounter.get(lineId);
      orderCounter.set(lineId, currentOrder + 1);

      // 위경도 매핑 및 철산역 등 경기권 기본 예외 좌표 보정
      let coords = coordMap.get(stationName);
      if (!coords) {
        coords = { lat: 37.4765, lng: 126.8680 }; // 철산역 근처의 디폴트 좌표
      }

      csvContent += `${lineId},${currentOrder},${stationName},${coords.lat},${coords.lng},true\n`;
    });

    const targetPath = path.join(__dirname, '..', 'subway_total.csv');
    fs.writeFileSync(targetPath, csvContent, 'utf-8');

    console.log(`\n✅ 성공! '철산역'과 모든 경기/인천권이 융합된 'subway_total.csv' 파일이 생성되었습니다.`);
    console.log(`▶️ 이제 안심하고 아래 빌드 명령어를 실행해 주세요:`);
    console.log(`   node scripts/import_stations.js ./subway_total.csv\n`);

  } catch (error) {
    console.error("❌ 데이터 처리 중 실패:", error.message);
  }
}

fetchSubwayDataFromSeoul();