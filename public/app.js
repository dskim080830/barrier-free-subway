const state = {
  stations: [],
  lineMeta: {},
  nameToId: new Map(),
};

const $ = (sel) => document.querySelector(sel);

async function init() {
  const res = await fetch("/api/stations");
  const data = await res.json();
  state.stations = data.stations;
  state.lineMeta = data.lineMeta;
  state.nameToId = new Map(state.stations.map((s) => [s.name, s.id]));

  const datalist = $("#station-list");
  datalist.innerHTML = state.stations
    .map((s) => `<option value="${s.name}"></option>`)
    .join("");

  $("#find-route-btn").addEventListener("click", handleFindRoute);
  $("#swap-btn").addEventListener("click", () => {
    const a = $("#start-input").value;
    $("#start-input").value = $("#end-input").value;
    $("#end-input").value = a;
  });

  for (const input of [$("#start-input"), $("#end-input")]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleFindRoute();
    });
  }
}

/** 실시간 도착정보 배열을 <li> 목록 HTML로 변환 (route-timeline 안에서도 재사용) */
function renderArrivalItems(arrivals, stationName) {
  if (!arrivals || arrivals.length === 0) {
    return `<li class="arrival-item arrival-item--empty">"${stationName}"의 실시간 도착정보가 없습니다.</li>`;
  }
  const items = arrivals.slice(0, Math.max(2, arrivals.length));
  return items
    .map(
      (a) => {
        const line = a.lineName || a.updnLine || "";
        const dest = a.destinationStation ? `→ ${a.destinationStation}행` : "";
        const pos = a.currentStation ? `(현재 ${a.currentStation})` : "";
        const time = a.remainingSeconds != null
          ? (a.remainingSeconds <= 0 ? "곧 도착" : `약 ${Math.ceil(a.remainingSeconds / 60)}분 후`)
          : (a.arrivalMessage || a.currentStatusMessage || "정보 없음");
        return `
        <li class="arrival-item">
          <span class="arrival-item__line">🚇 ${line} ${dest}</span>
          <span class="arrival-item__msg">${time} ${pos}</span>
        </li>`;
      }
    )
    .join("");
}

function showError(message) {
  const el = $("#search-error");
  el.textContent = message;
  el.hidden = false;
  $("#result-section").hidden = true;
}

function clearError() {
  $("#search-error").hidden = true;
}

async function handleFindRoute() {
  clearError();
  const startName = $("#start-input").value.trim();
  const endName = $("#end-input").value.trim();

  const startId = state.nameToId.get(startName);
  const endId = state.nameToId.get(endName);

  if (!startId) return showError(`"${startName}"은(는) 등록된 역이 아닙니다. 목록에서 선택해 주세요.`);
  if (!endId) return showError(`"${endName}"은(는) 등록된 역이 아닙니다. 목록에서 선택해 주세요.`);
  if (startId === endId) return showError("출발역과 도착역이 같습니다.");

  const res = await fetch(`/api/route?start=${startId}&end=${endId}`);
  const data = await res.json();

  if (!data.ok) return showError(data.reason);

  renderResult(data);
}

function renderResult(data) {
  $("#result-section").hidden = false;

  const noteEl = $("#route-note");
  if (noteEl) {
    if (data.note) {
      noteEl.textContent = `ℹ️ ${data.note}`;
      noteEl.hidden = false;
    } else {
      noteEl.hidden = true;
    }
  }

  $("#route-summary").innerHTML = `
    <div>
      <div class="stat-num">${data.totalStops}</div>
      <div class="stat-label">총 정차역 수</div>
    </div>
    <div>
      <div class="stat-num">${data.transfers.length}</div>
      <div class="stat-label">환승 횟수</div>
    </div>
    <div>
      <div class="stat-num">${data.estimatedMinutes}분</div>
      <div class="stat-label">예상 소요시간</div>
    </div>
    <div style="flex:1; min-width:180px;">
      <div class="stat-label" style="margin-bottom:6px;">이용 노선</div>
      <div>${[...new Set(data.segmentLines)].map(lineBadge).join(" ")}</div>
    </div>
  `;

  const timeline = $("#route-timeline");
  timeline.innerHTML = data.stops
    .map((stop, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === data.stops.length - 1;
      const lineForColor = idx === 0 ? data.segmentLines[0] : data.segmentLines[Math.min(idx - 1, data.segmentLines.length - 1)];
      const color = lineColorByLabel(lineForColor);

      const badge = accessibilityBadge(stop);
      const roleLabel = isFirst ? "출발" : isLast ? "도착" : stop.isTransfer ? "환승" : "경유";

      return `
        <li class="stop ${stop.isTransfer ? "stop--transfer" : ""}" style="--line-color:${color}">
          <div class="stop__dot"></div>
          <div class="stop__body">
            <div class="stop__top">
              <span class="stop__name">${stop.name}</span>
              <span class="line-badge">${roleLabel}</span>
              <span class="elevator-badge ${badge.ok ? "elevator-badge--ok" : "elevator-badge--bad"}">
                ${badge.text}
              </span>
            </div>
            ${stop.quickExit ? `<div class="quick-exit">🚪 ${stop.quickExit.note || `${stop.quickExit.carNumber}번째 칸 ${stop.quickExit.doorNumber}번 문 쪽이 가장 가깝습니다.`}</div>` : ""}
            ${
              stop.realtimeArrival && stop.realtimeArrival.length > 0
                ? `<ul class="arrival-list arrival-list--inline">${renderArrivalItems(stop.realtimeArrival, stop.name)}</ul>`
                : ""
            }
          </div>
        </li>
      `;
    })
    .join("");
}

function lineBadge(label) {
  return `<span class="line-badge" style="background:${lineColorByLabel(label)}">${label}</span>`;
}

// 노선명 → 색상. LINE_META와 완전히 같은 문자열이 아니어도(예: ODsay가 준
// 이름에 부가 표기가 붙는 경우) 부분 일치로 최대한 찾아내고, 그래도 못 찾으면
// 라벨 문자열 해시로 고정된 색을 만들어서 "노선마다 색이 다르게" 보이게 합니다
// (전부 똑같은 기본색으로 뭉개지는 걸 방지).
const FALLBACK_PALETTE = [
  "#0068b7", "#e6186c", "#00a84d", "#ef7c1c", "#996cac",
  "#cd7c2f", "#747f00", "#0090d2", "#d4003b", "#8e44ad",
];

function lineColorByLabel(label) {
  if (!label) return FALLBACK_PALETTE[0];

  const metaList = Object.values(state.lineMeta);
  let entry = metaList.find((m) => m.name === label);
  if (!entry) {
    // 완전 일치가 없으면 부분 일치(예: "서울 2호선" ⊃ "2호선")로 재시도
    entry = metaList.find((m) => label.includes(m.name) || m.name.includes(label));
  }
  if (entry) return entry.color;

  // 그래도 못 찾으면 라벨 문자열을 해시해서 팔레트에서 고정 색을 고릅니다.
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

/** stop.elevator / stop.lift 상태를 합쳐서 하나의 배지 정보로 만듭니다. */
function accessibilityBadge(stop) {
  const elevatorOk = Boolean(stop.elevator && stop.elevator.installed && stop.elevator.operational);
  const liftOk = Boolean(stop.lift && stop.lift.installed && stop.lift.operational);

  if (elevatorOk) return { ok: true, text: "♿ 엘리베이터 이용 가능" };
  if (liftOk) return { ok: true, text: "🦽 휠체어리프트 이용 가능" };
  return { ok: false, text: "⚠ 엘리베이터·리프트 이용 불가" };
}

init();
