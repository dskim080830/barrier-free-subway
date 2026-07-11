# 계단 없는 길 — 배리어프리 지하철 환승 경로 웹

팀 태양 (30303 김두성) — BFS/ODsay 경로 위에서 **엘리베이터 또는 휠체어리프트가
있는 역만** 골라 최소 정차역 경로를 찾고, 내려서 **어느 칸·몇 번 문**으로
가야 그 시설이 가장 가까운지까지 안내하는 웹 서비스입니다.

## 1. 핵심 동작 원리

**왜 카카오맵이 아니라 ODsay인가?** 카카오맵은 자동차/도보 길찾기 REST API는
공개하지만, "지하철 역간 대중교통 경로(환승 포함)"를 계산해주는 공개 API는
제공하지 않습니다(지도 앱 UI 안에서만 제공). 그래서 국내 대중교통 경로
탐색용으로 널리 쓰이는 **ODsay** 공개 API로 실제 경로를 받아옵니다.

1. 출발역·도착역 좌표로 ODsay에 **실제로 존재하는 지하철 경로 후보**를
   여러 개 요청합니다 → `src/odsayApi.js`
2. 소요시간이 짧은 순서로 후보를 확인하면서, **승차역·환승역·하차역**에
   지금 이용 가능한 엘리베이터 **또는 휠체어리프트**가 있는지 서울교통공사
   실시간 데이터로 대조합니다. 엘리베이터가 고장이어도 리프트가 있으면
   통과시키고, 둘 다 없으면 그 후보는 버리고 **다음 후보 경로를 자동으로
   재탐색**합니다 → `src/server.js`의 `checkOdsayPathAccessible`
3. ODsay 키가 없거나, API 호출이 실패하거나, 받아온 모든 후보가 막혀 있으면
   기존 방식(내부에 손으로 입력해둔 제한적인 역·구간 데이터 기준 BFS)으로
   자동 폴백합니다 → `src/graph.js`. 이 경우 응답에 `source:
   "internal-graph-fallback"`과 안내 문구(`note`)가 함께 내려가며, 화면에도
   노란 배너로 표시됩니다.
4. 실시간 엘리베이터·휠체어리프트 고장 여부는 서울교통공사
   **편의시설위치정보**(엘리베이터)와 **지하철역 교통약자이용정보**(휠체어리프트)
   API로 각각 조회합니다(역 이름 기준으로 바로 조회하므로 ODsay가 알려준
   아무 역이나 대조 가능) → `src/seoulOpenApi.js`의 `fetchElevatorStatusAll` /
   `fetchLiftStatusAll`
5. 경로가 정해지면 승차역·환승역·하차역에서 서울교통공사 **빠른하차정보**
   API로 "가장 가까운 몇 번째 칸 몇 번 문"을 조회해 붙여줍니다. 엘리베이터
   정보가 없으면 자동으로 휠체어리프트 정보로 대체해서 보여줍니다
   → `src/seoulOpenApi.js`의 `fetchQuickExitInfo`

```
src/odsayApi.js               ODsay 대중교통 경로 API 연동 + 지하철 전용 필터링
data/stations.js, edges.js   내부 폴백용 역·구간 데이터 (핵심 노선만)
src/graph.js                 폴백용 그래프 구성 + 배리어프리 BFS
src/seoulOpenApi.js           공공데이터 API 연동 (mock 모드 내장)
src/elevatorStatusCache.js   폴백 경로용 실시간 상태 캐시 + 주기 갱신
src/server.js                 Express REST API + 정적 서빙 + ODsay↔폴백 전환 로직
public/                      프론트엔드 (바닐라 HTML/CSS/JS)
scripts/import_stations.js   전체 수도권 데이터로 확장하는 CSV 임포터 (폴백용)
```

## 2. 실행 방법

```bash
npm install
cp .env.example .env
npm start
# http://localhost:3000 접속
```

`.env`의 `USE_MOCK_ELEVATOR_API=true` 상태로 두면 API 키 없이도 바로 실행/
발표가 가능합니다. 화면 하단에 "시연 도구" 패널이 나타나 특정 역을
"고장"으로 표시해 우회 경로를 찾는 것을 직접 보여줄 수 있습니다.

**실제 경로(ODsay)로 시연하려면** [lab.odsay.com](https://lab.odsay.com)에서
무료 API 키를 발급받아 `.env`의 `ODSAY_API_KEY`에 넣어주세요. 비워두면
자동으로 내부 폴백 경로(제한된 역 데이터 기준)만 사용합니다.

## 3. 실제 공공데이터 API 연동하기

1. 공공데이터포털(data.go.kr)에서 아래 두 데이터에 **활용신청**하고
   서비스키를 발급받습니다.
   - 서울교통공사_편의시설위치정보 (엘리베이터 실시간 고장 여부)
   - 서울교통공사_빠른하차정보 (엘리베이터와 가장 가까운 승하차 문)
2. `.env`에 `DATA_GO_KR_SERVICE_KEY`를 넣고 `USE_MOCK_ELEVATOR_API=false`로
   바꿉니다.
3. **꼭 확인할 것**: 발급받은 키로 Swagger(활용 명세)를 열어 실제 응답
   필드명을 확인한 뒤 `src/seoulOpenApi.js` 맨 위 `FIELD_MAP` 객체와
   `BASE` 요청 경로만 그대로 맞춰 고치면 됩니다. (공공데이터포털 API는
   기관마다 필드명이 조금씩 달라 이 부분만 실제 문서를 보고 확정해야
   합니다 — 이 저장소를 만드는 시점에는 인증키가 없어 Swagger 실물 응답을
   확인할 수 없었기 때문에 필드명은 예시로 채워두었습니다.)

## 4. 데이터 범위와 "전체 수도권으로 확장하기"

`data/stations.js` / `data/edges.js`에는 **실제로 인접이 확인된 구간만**
넣었습니다 (2호선 순환선은 전 구간 정확한 순서로 모두 포함). 700개가 넘는
수도권 전 역을 손으로 입력하면 순서 오류가 생기기 쉬워, 확신이 없는 구간은
비워두고 대신 자동 확장 스크립트를 만들어 두었습니다.

1. 공공데이터포털에서 "서울교통공사_노선별 지하철역 정보"(역명·호선·순서)
   와 역 좌표 데이터를 내려받아 아래 형식의 CSV로 정리합니다.
   ```
   line,order,stationName,lat,lng,hasElevatorInstalled
   2,1,시청,37.5658,126.9772,true
   ```
2. 실행:
   ```bash
   node scripts/import_stations.js ./전체역정보.csv
   ```
3. `data/stations.generated.js`, `data/edges.generated.js`가 생성되고
   서버 재시작 시 기존 데이터와 자동으로 합쳐집니다(동일 역명은 하나의
   환승 노드로 병합). 코드 수정이 전혀 필요 없습니다.

## 5. 알고리즘 설계 메모 (발표 자료용)

- 그래프 노드 = **물리적인 역 1개** (환승역은 여러 호선을 공유하는 하나의
  노드로 표현해 "환승"이 자연스럽게 BFS 경로에 포함됩니다)
- 간선 = 같은 호선에서 실제로 바로 옆인 두 역 (`line` 속성 보유)
- BFS 방문 조건: `hasElevatorInstalled === true` **그리고** 실시간
  `operational !== false` 인 역만 큐에 넣음 → 정차역 수가 최소인 경로 중
  하나가 곧 "계단 없는 최단 환승 경로"가 됩니다.
- 환승 지점은 경로를 역추적하면서 인접한 두 구간의 `line`이 달라지는
  지점으로 계산합니다.
