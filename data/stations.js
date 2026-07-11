/**
 * 수도권 지하철 역 데이터
 * ------------------------------------------------------------------
 * ⚠️ 중요 안내
 * 실제 수도권 지하철은 20여 개 노선, 700개 이상의 역으로 구성되어 있어
 * 전 역을 이 파일에 손으로 입력하면 값이 실제와 어긋날 위험이 큽니다.
 * 그래서 이 파일은 "핵심 노선(1~9호선 서울 구간 + 주요 연장/환승 노선)"을
 * 담은 실행 가능한 시연용 데이터로 구성했고, 나머지 역은
 * scripts/import_stations.js 로 공공데이터포털의
 * "서울교통공사_노선별 지하철역 정보" CSV를 불러오면 자동으로 합쳐지도록
 * 설계했습니다. (README의 "전체 수도권으로 확장하기" 참고)
 *
 * hasElevatorInstalled: 역에 승강기 설비 자체가 "설치되어 있는지" (고정 정보)
 *   → 실시간 "고장 여부"는 설치 여부와 별개로 서울교통공사 편의시설위치정보
 *      API에서 매번 새로 받아와 elevatorStatusCache 에 덮어씁니다.
 */

const LINE_META = {
  // ── 기존 큐레이션 데이터(핵심 노선)의 숫자/약어 키 ──
  1: { name: "1호선", color: "#0052A4" },
  2: { name: "2호선", color: "#00A84D" },
  3: { name: "3호선", color: "#EF7C1C" },
  4: { name: "4호선", color: "#00A5DE" },
  5: { name: "5호선", color: "#996CAC" },
  6: { name: "6호선", color: "#CD7C2F" },
  7: { name: "7호선", color: "#747F00" },
  8: { name: "8호선", color: "#E6186C" },
  9: { name: "9호선", color: "#BDB092" },
  SB: { name: "신분당선", color: "#D4003B" },
  AREX: { name: "공항철도", color: "#0090D2" },
  KJ: { name: "경의중앙선", color: "#77C4A3" },
  SIN: { name: "수인분당선", color: "#FABE00" },

  // ── 전국도시철도역사정보표준데이터(공공데이터포털) 기반 노선번호 키 ──
  "I1101": { name: "1호선", color: "#0052A4" },
  "I1103": { name: "3호선", color: "#EF7C1C" },
  "I1104": { name: "4호선", color: "#00A5DE" },
  "I11D1": { name: "신분당선", color: "#D4003B" },
  "I26K6": { name: "동해선", color: "#8E44AD" },
  "I27K7": { name: "대경선", color: "#16A085" },
  "I28A1": { name: "인천국제공항선", color: "#2C3E50" },
  "I28K1": { name: "수인선", color: "#FABE00" },
  "I4101": { name: "1호선", color: "#0052A4" },
  "I4102": { name: "1호선", color: "#0052A4" },
  "I4103": { name: "안산과천선", color: "#4A90D9" },
  "I4104": { name: "진접선", color: "#8FBC8F" },
  "I4105": { name: "분당선", color: "#FABE00" },
  "I4106": { name: "일산선", color: "#7B68EE" },
  "I4108": { name: "경의중앙선", color: "#77C4A3" },
  "I41K2": { name: "경춘선", color: "#0C8E72" },
  "I41K5": { name: "경강선", color: "#003DA5" },
  "I41WS": { name: "서해선", color: "#D35400" },
  "I4401": { name: "1호선", color: "#0052A4" },
  "L11SL": { name: "신림선", color: "#6789CA" },
  "L11UI": { name: "우이신설선", color: "#B0CE18" },
  "L41E1": { name: "에버라인", color: "#C0392B" },
  "L41G1": { name: "김포도시철도", color: "#AD8605" },
  "L41U1": { name: "의정부경전철", color: "#FDA600" },
  "S1102": { name: "2호선", color: "#00A84D" },
  "S1105": { name: "5호선", color: "#996CAC" },
  "S1106": { name: "6호선", color: "#CD7C2F" },
  "S1107": { name: "7호선", color: "#747F00" },
  "S1108": { name: "8호선", color: "#E6186C" },
  "S1109": { name: "9호선", color: "#BDB092" },
  "S1121": { name: "2호선", color: "#00A84D" },
  "S1122": { name: "2호선", color: "#00A84D" },
  "S2801": { name: "인천지하철 1호선", color: "#759CCE" },
  "S2802": { name: "인천지하철 2호선", color: "#F5A200" },
  "S28M1": { name: "자기부상철도", color: "#27AE60" },
  "S4108": { name: "8호선", color: "#E6186C" },
};

// station id 규칙: st_<역이름 로마자/약어>  (환승역은 물리적으로 하나의 노드)
const STATIONS = [
  // ── 2호선 순환 (전 구간) ─────────────────────────────────────────
  { id: "st_cityhall", name: "시청", lines: [1, 2], lat: 37.5658, lng: 126.9772, hasElevatorInstalled: true },
  { id: "st_euljiro1", name: "을지로입구", lines: [2], lat: 37.5660, lng: 126.9827, hasElevatorInstalled: true },
  { id: "st_euljiro3", name: "을지로3가", lines: [2, 3], lat: 37.5663, lng: 126.9915, hasElevatorInstalled: true },
  { id: "st_euljiro4", name: "을지로4가", lines: [2, 5], lat: 37.5664, lng: 126.9977, hasElevatorInstalled: true },
  { id: "st_dongdaemunhp", name: "동대문역사문화공원", lines: [2, 4, 5], lat: 37.5652, lng: 127.0079, hasElevatorInstalled: true },
  { id: "st_sindang", name: "신당", lines: [2, 6], lat: 37.5654, lng: 127.0175, hasElevatorInstalled: true },
  { id: "st_sangwangsimni", name: "상왕십리", lines: [2], lat: 37.5644, lng: 127.0296, hasElevatorInstalled: true },
  { id: "st_wangsimni", name: "왕십리", lines: [2, 5, "SIN"], lat: 37.5615, lng: 127.0374, hasElevatorInstalled: true },
  { id: "st_hanyangu", name: "한양대", lines: [2], lat: 37.5563, lng: 127.0438, hasElevatorInstalled: true },
  { id: "st_ttukseom", name: "뚝섬", lines: [2], lat: 37.5474, lng: 127.0472, hasElevatorInstalled: true },
  { id: "st_seongsu", name: "성수", lines: [2], lat: 37.5447, lng: 127.0559, hasElevatorInstalled: true },
  { id: "st_konkuk", name: "건대입구", lines: [2, 7], lat: 37.5403, lng: 127.0700, hasElevatorInstalled: true },
  { id: "st_guui", name: "구의", lines: [2], lat: 37.5369, lng: 127.0855, hasElevatorInstalled: true },
  { id: "st_gangbyeon", name: "강변", lines: [2], lat: 37.5352, lng: 127.0946, hasElevatorInstalled: true },
  { id: "st_jamsilnaru", name: "잠실나루", lines: [2], lat: 37.5205, lng: 127.1035, hasElevatorInstalled: true },
  { id: "st_jamsil", name: "잠실", lines: [2, 8], lat: 37.5133, lng: 127.1001, hasElevatorInstalled: true },
  { id: "st_jamsilsaenae", name: "잠실새내", lines: [2], lat: 37.5111, lng: 127.0863, hasElevatorInstalled: true },
  { id: "st_sportscomplex", name: "종합운동장", lines: [2, 9], lat: 37.5109, lng: 127.0735, hasElevatorInstalled: true },
  { id: "st_samsung", name: "삼성", lines: [2], lat: 37.5088, lng: 127.0631, hasElevatorInstalled: true },
  { id: "st_seolleung", name: "선릉", lines: [2, "SIN"], lat: 37.5044, lng: 127.0489, hasElevatorInstalled: true },
  { id: "st_yeoksam", name: "역삼", lines: [2], lat: 37.5006, lng: 127.0364, hasElevatorInstalled: true },
  { id: "st_gangnam", name: "강남", lines: [2, "SB"], lat: 37.4979, lng: 127.0276, hasElevatorInstalled: true },
  { id: "st_gyodae", name: "교대", lines: [2, 3], lat: 37.4934, lng: 127.0142, hasElevatorInstalled: true },
  { id: "st_seocho", name: "서초", lines: [2], lat: 37.4919, lng: 127.0079, hasElevatorInstalled: true },
  { id: "st_bangbae", name: "방배", lines: [2], lat: 37.4816, lng: 126.9975, hasElevatorInstalled: true },
  { id: "st_sadang", name: "사당", lines: [2, 4], lat: 37.4766, lng: 126.9816, hasElevatorInstalled: true },
  { id: "st_nakseongdae", name: "낙성대", lines: [2], lat: 37.4767, lng: 126.9634, hasElevatorInstalled: true },
  { id: "st_seoulnatl", name: "서울대입구", lines: [2], lat: 37.4812, lng: 126.9528, hasElevatorInstalled: true },
  { id: "st_bongcheon", name: "봉천", lines: [2], lat: 37.4824, lng: 126.9427, hasElevatorInstalled: true },
  { id: "st_sillim", name: "신림", lines: [2], lat: 37.4844, lng: 126.9296, hasElevatorInstalled: true },
  { id: "st_sindaebang", name: "신대방", lines: [2], lat: 37.4870, lng: 126.9134, hasElevatorInstalled: true },
  { id: "st_guro_digital", name: "구로디지털단지", lines: [2], lat: 37.4852, lng: 126.9014, hasElevatorInstalled: true },
  { id: "st_daerim", name: "대림", lines: [2, 7], lat: 37.4931, lng: 126.8955, hasElevatorInstalled: true },
  { id: "st_sindorim", name: "신도림", lines: [1, 2], lat: 37.5088, lng: 126.8912, hasElevatorInstalled: true },
  { id: "st_mullae", name: "문래", lines: [2], lat: 37.5178, lng: 126.8951, hasElevatorInstalled: true },
  { id: "st_yeongdeungpogu", name: "영등포구청", lines: [2, 5], lat: 37.5251, lng: 126.8961, hasElevatorInstalled: true },
  { id: "st_dangsan", name: "당산", lines: [2], lat: 37.5345, lng: 126.9027, hasElevatorInstalled: true },
  { id: "st_hapjeong", name: "합정", lines: [2, 6], lat: 37.5495, lng: 126.9139, hasElevatorInstalled: true },
  { id: "st_hongikuniv", name: "홍대입구", lines: [2, "AREX", "KJ"], lat: 37.5572, lng: 126.9245, hasElevatorInstalled: true },
  { id: "st_sinchon", name: "신촌", lines: [2], lat: 37.5551, lng: 126.9366, hasElevatorInstalled: true },
  { id: "st_ewha", name: "이대", lines: [2], lat: 37.5570, lng: 126.9463, hasElevatorInstalled: true },
  { id: "st_ahyeon", name: "아현", lines: [2], lat: 37.5573, lng: 126.9558, hasElevatorInstalled: true },
  { id: "st_chungjeongno", name: "충정로", lines: [2, 5], lat: 37.5598, lng: 126.9636, hasElevatorInstalled: true },

  // ── 1호선 (서울 도심 구간) ───────────────────────────────────────
  { id: "st_seoul_station", name: "서울역", lines: [1, 4, "AREX", "KJ"], lat: 37.5547, lng: 126.9707, hasElevatorInstalled: true },
  { id: "st_namyeong", name: "남영", lines: [1], lat: 37.5416, lng: 126.9711, hasElevatorInstalled: true },
  { id: "st_yongsan", name: "용산", lines: [1, "KJ"], lat: 37.5299, lng: 126.9648, hasElevatorInstalled: true },
  { id: "st_jongno3", name: "종로3가", lines: [1, 3, 5], lat: 37.5717, lng: 126.9917, hasElevatorInstalled: true },
  { id: "st_jonggak", name: "종각", lines: [1], lat: 37.5701, lng: 126.9832, hasElevatorInstalled: true },
  { id: "st_cheongnyangni", name: "청량리", lines: [1, "KJ", "SIN"], lat: 37.5803, lng: 127.0470, hasElevatorInstalled: true },
  { id: "st_guro", name: "구로", lines: [1], lat: 37.5030, lng: 126.8817, hasElevatorInstalled: true },

  // ── 3호선 ───────────────────────────────────────────────────────
  { id: "st_apgujeong", name: "압구정", lines: [3], lat: 37.5270, lng: 127.0284, hasElevatorInstalled: true },
  { id: "st_dogok", name: "도곡", lines: [3], lat: 37.4908, lng: 127.0552, hasElevatorInstalled: true },
  { id: "st_yangjae", name: "양재", lines: [3], lat: 37.4843, lng: 127.0344, hasElevatorInstalled: true },
  { id: "st_gyeongbokgung", name: "경복궁", lines: [3], lat: 37.5758, lng: 126.9736, hasElevatorInstalled: true },
  { id: "st_anguk", name: "안국", lines: [3], lat: 37.5762, lng: 126.9853, hasElevatorInstalled: true },
  { id: "st_ogeum", name: "오금", lines: [3, 5], lat: 37.5030, lng: 127.1284, hasElevatorInstalled: true },

  // ── 4호선 ───────────────────────────────────────────────────────
  { id: "st_myeongdong", name: "명동", lines: [4], lat: 37.5606, lng: 126.9856, hasElevatorInstalled: true },
  { id: "st_hyehwa", name: "혜화", lines: [4], lat: 37.5824, lng: 127.0016, hasElevatorInstalled: true },
  { id: "st_dongdaemun", name: "동대문", lines: [1, 4], lat: 37.5712, lng: 127.0097, hasElevatorInstalled: true },
  { id: "st_isu", name: "이수", lines: [4, 7], lat: 37.4855, lng: 126.9819, hasElevatorInstalled: true },
  { id: "st_ansan", name: "안산", lines: [4], lat: 37.3236, lng: 126.8219, hasElevatorInstalled: true },

  // ── 5호선 ───────────────────────────────────────────────────────
  { id: "st_gwanghwamun", name: "광화문", lines: [5], lat: 37.5720, lng: 126.9764, hasElevatorInstalled: true },
  { id: "st_yeouido", name: "여의도", lines: [5, 9], lat: 37.5217, lng: 126.9243, hasElevatorInstalled: true },
  { id: "st_yeouinaru", name: "여의나루", lines: [5], lat: 37.5269, lng: 126.9328, hasElevatorInstalled: true },
  { id: "st_gimpoairport", name: "김포공항", lines: [5, 9, "AREX"], lat: 37.5622, lng: 126.8014, hasElevatorInstalled: true },
  { id: "st_gunja", name: "군자", lines: [5, 7], lat: 37.5573, lng: 127.0793, hasElevatorInstalled: true },
  { id: "st_gangdong", name: "강동", lines: [5, 8], lat: 37.5352, lng: 127.1338, hasElevatorInstalled: true },

  // ── 6호선 ───────────────────────────────────────────────────────
  { id: "st_yeonnam", name: "연신내", lines: [3, 6], lat: 37.6191, lng: 126.9207, hasElevatorInstalled: true },
  { id: "st_gongdeok", name: "공덕", lines: [5, 6, "AREX", "KJ"], lat: 37.5445, lng: 126.9514, hasElevatorInstalled: true },
  { id: "st_itaewon", name: "이태원", lines: [6], lat: 37.5346, lng: 126.9946, hasElevatorInstalled: true },
  { id: "st_dgu_station", name: "동대입구", lines: [3], lat: 37.5586, lng: 127.0057, hasElevatorInstalled: true },
  { id: "st_sangwol", name: "상월곡", lines: [6], lat: 37.6081, lng: 127.0498, hasElevatorInstalled: true },

  // ── 7호선 ───────────────────────────────────────────────────────
  { id: "st_taereung", name: "태릉입구", lines: [6, 7], lat: 37.6180, lng: 127.0752, hasElevatorInstalled: true },
  { id: "st_gasan_digital", name: "가산디지털단지", lines: [1, 7], lat: 37.4816, lng: 126.8826, hasElevatorInstalled: true },
  { id: "st_gangnamgu", name: "강남구청", lines: [7, "SIN"], lat: 37.5175, lng: 127.0413, hasElevatorInstalled: true },
  { id: "st_bupyeonggurau", name: "부평구청", lines: [7], lat: 37.5089, lng: 126.7218, hasElevatorInstalled: true },

  // ── 8호선 ───────────────────────────────────────────────────────
  { id: "st_mongchon", name: "몽촌토성", lines: [8], lat: 37.5169, lng: 127.1113, hasElevatorInstalled: true },
  { id: "st_moran", name: "모란", lines: [8, "SIN"], lat: 37.4327, lng: 127.1290, hasElevatorInstalled: true },
  { id: "st_bokjeong", name: "복정", lines: [8, "SIN"], lat: 37.4700, lng: 127.1266, hasElevatorInstalled: true },
  { id: "st_amsa", name: "암사", lines: [8], lat: 37.5504, lng: 127.1276, hasElevatorInstalled: true },

  // ── 9호선 ───────────────────────────────────────────────────────
  { id: "st_seonyudo", name: "선유도", lines: [9], lat: 37.5382, lng: 126.8945, hasElevatorInstalled: true },
  { id: "st_noryangjin", name: "노량진", lines: [1, 9], lat: 37.5138, lng: 126.9426, hasElevatorInstalled: true },
  { id: "st_sinnonhyeon", name: "신논현", lines: [9, "SB"], lat: 37.5045, lng: 127.0252, hasElevatorInstalled: true },
  { id: "st_bongeunsa", name: "봉은사", lines: [9], lat: 37.5145, lng: 127.0605, hasElevatorInstalled: true },

  // ── 신분당선 ────────────────────────────────────────────────────
  { id: "st_pangyo", name: "판교", lines: ["SB", "SIN"], lat: 37.3948, lng: 127.1114, hasElevatorInstalled: true },
  { id: "st_jeongja", name: "정자", lines: ["SB", "SIN"], lat: 37.3668, lng: 127.1082, hasElevatorInstalled: true },
  { id: "st_gwanggyo", name: "광교", lines: ["SB"], lat: 37.2999, lng: 127.0553, hasElevatorInstalled: true },

  // ── 수인분당선 ──────────────────────────────────────────────────
  { id: "st_suwon", name: "수원", lines: ["SIN", 1], lat: 37.2660, lng: 127.0004, hasElevatorInstalled: true },
  { id: "st_incheon_univ", name: "인천대입구", lines: ["SIN"], lat: 37.3892, lng: 126.6402, hasElevatorInstalled: true },

  // ── 공항철도 ────────────────────────────────────────────────────
  { id: "st_gimpo_intl", name: "인천공항1터미널", lines: ["AREX"], lat: 37.4488, lng: 126.4505, hasElevatorInstalled: true },
  { id: "st_digital_media", name: "디지털미디어시티", lines: [6, "AREX", "KJ"], lat: 37.5769, lng: 126.9004, hasElevatorInstalled: true },

  // ── 경의중앙선 ──────────────────────────────────────────────────
  { id: "st_ilsan", name: "일산", lines: ["KJ"], lat: 37.6773, lng: 126.7699, hasElevatorInstalled: true },
  { id: "st_munsan", name: "문산", lines: ["KJ"], lat: 37.8514, lng: 126.7862, hasElevatorInstalled: true },
];

module.exports = { STATIONS, LINE_META };
