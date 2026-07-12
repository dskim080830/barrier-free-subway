const state = {
  stations: [],
  lineMeta: {},
  nameToId: new Map(),
};

let arrivalPollingTimer = null;
let countdownTimer = null;
let currentStops = [];

const $ = (sel) => document.querySelector(sel);

async function init() {
  const res = await fetch("/api/stations");
  const data = await res.json();
  state.stations = data.stations;
  state.lineMeta = data.lineMeta;
  state.nameToId = new Map(state.stations.map((s) => [s.name, s.id]));

  function stripSuffix(name) {
    let s = name;
    if (s.length > 1 && s.endsWith("역")) s = s.slice(0, -1);
    s = s.replace(/\([^)]*\)\s*$/, "").trim();
    if (s.length > 1 && s.endsWith("역")) s = s.slice(0, -1);
    return s;
  }

  for (const s of state.stations) {
    const base = stripSuffix(s.name);
    if (base !== s.name && !state.nameToId.has(base)) {
      state.nameToId.set(base, s.id);
    }
  }

  const linesByBase = new Map();
  for (const s of state.stations) {
    const base = stripSuffix(s.name);
    if (!linesByBase.has(base)) linesByBase.set(base, new Set());
    for (const l of s.lines) {
      const meta = state.lineMeta[l];
      if (meta) linesByBase.get(base).add(meta.name);
    }
  }

  const datalist = $("#station-list");
  const seen = new Set();
  datalist.innerHTML = state.stations
    .filter((s) => {
      const base = stripSuffix(s.name);
      if (seen.has(base)) return false;
      seen.add(base);
      return true;
    })
    .map((s) => {
      const base = stripSuffix(s.name);
      const lines = linesByBase.get(base);
      const lineLabel = lines && lines.size > 0 ? ` (${[...lines].join(", ")})` : "";
      return `<option value="${s.name}" label="${s.name}${lineLabel}"></option>`;
    })
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

function stopPolling() {
  if (arrivalPollingTimer) { clearInterval(arrivalPollingTimer); arrivalPollingTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

const EXPRESS_STOP_PATTERNS = {
  "1호선": {
    "급행": {
      "천안": "용산·영등포·안양·수원·오산·평택·천안",
      "신창": "용산·영등포·안양·수원·오산·평택·천안·신창",
      "서동탄": "용산·영등포·안양·수원·서동탄",
      "병점": "용산·영등포·안양·수원·병점",
      "수원": "용산·영등포·안양·수원",
      "인천": "용산·영등포·부천·부평·인천",
      "동인천": "용산·영등포·부천·부평·동인천",
      "소요산": "용산·청량리·의정부·소요산",
    },
    "특급": {
      "천안": "용산·수원·평택·천안",
      "신창": "용산·수원·평택·천안·신창",
    },
  },
};

function extractStopInfo(lineName) {
  if (!lineName) return "";
  const destMatch = lineName.match(/^(.+?)행/);
  if (!destMatch) return "";
  const dest = destMatch[1];

  const typeMatch = lineName.match(/(급행|특급)/);
  const trainType = typeMatch ? typeMatch[1] : "";
  if (!trainType) return "";

  for (const [line, types] of Object.entries(EXPRESS_STOP_PATTERNS)) {
    const stops = types[trainType];
    if (stops && stops[dest]) {
      return `정차: ${stops[dest]}`;
    }
  }
  return "";
}

function renderArrivalItems(arrivals, stationName) {
  if (!arrivals || arrivals.length === 0) {
    return `<li class="arrival-item arrival-item--empty">"${stationName}"의 실시간 도착정보가 없습니다.</li>`;
  }
  return arrivals.slice(0, 4)
    .map((a) => {
      const dest = a.destinationStation ? `${a.destinationStation}행` : "";
      const dirMatch = (a.lineName || "").match(/- (.+방면)/);
      const dirLabel = dirMatch ? dirMatch[1] : "";
      const trainInfo = dirLabel ? `${dest} (${dirLabel})` : dest;
      let badge = "";
      if (a.trainStatus === "급행") badge = `<span class="express-badge">급행</span> `;
      else if (a.trainStatus === "특급") badge = `<span class="express-badge express-badge--special">특급</span> `;

      const stopInfo = (a.trainStatus === "급행" || a.trainStatus === "특급") && a.lineName
        ? extractStopInfo(a.lineName) : "";

      const pos = a.currentStation ? `(현재 ${a.currentStation})` : "";
      const time = a.remainingSeconds != null
        ? (a.remainingSeconds <= 0 ? "곧 도착" : `약 ${Math.ceil(a.remainingSeconds / 60)}분 후`)
        : (a.arrivalMessage || a.currentStatusMessage || "정보 없음");
      return `
        <li class="arrival-item">
          <span class="arrival-item__line">🚇 ${badge}${trainInfo}</span>
          ${stopInfo ? `<span class="arrival-item__stops">${stopInfo}</span>` : ""}
          <span class="arrival-item__msg">${time} ${pos}</span>
        </li>`;
    })
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
  stopPolling();

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

  currentStops = data.stops;
  renderResult(data);
  startArrivalPolling();
}

async function fetchArrivalForStop(stop) {
  if (!stop.arrivalMeta) return null;
  const params = new URLSearchParams({ station: stop.name, line: stop.arrivalMeta.line });
  if (stop.arrivalMeta.direction) params.set("direction", stop.arrivalMeta.direction);
  try {
    const res = await fetch(`/api/realtime-arrival?${params}`);
    const data = await res.json();
    return data.arrivals || [];
  } catch { return null; }
}

async function refreshAllArrivals() {
  const stopsWithMeta = currentStops.filter((s) => s.arrivalMeta);
  const results = await Promise.all(stopsWithMeta.map(fetchArrivalForStop));
  stopsWithMeta.forEach((stop, i) => {
    if (results[i] !== null) {
      stop.realtimeArrival = results[i];
      stop._lastFetchTime = Date.now();
    }
  });
  updateArrivalUI();
}

function startArrivalPolling() {
  refreshAllArrivals();
  arrivalPollingTimer = setInterval(refreshAllArrivals, 15000);
  countdownTimer = setInterval(updateArrivalUI, 1000);
}

function updateArrivalUI() {
  currentStops.forEach((stop, idx) => {
    const container = document.querySelector(`[data-stop-idx="${idx}"] .arrival-list--inline`);
    if (!container) return;
    if (!stop.realtimeArrival || stop.realtimeArrival.length === 0) {
      container.innerHTML = renderArrivalItems(null, stop.name);
      return;
    }
    const elapsed = stop._lastFetchTime ? (Date.now() - stop._lastFetchTime) / 1000 : 0;
    const adjusted = stop.realtimeArrival.map((a) => {
      if (a.remainingSeconds == null) return a;
      return { ...a, remainingSeconds: Math.max(0, a.remainingSeconds - elapsed) };
    });
    container.innerHTML = renderArrivalItems(adjusted, stop.name);
  });
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
      const stopLine = stop.lineName || (idx === 0 ? data.segmentLines[0] : data.segmentLines[Math.min(idx - 1, data.segmentLines.length - 1)]);
      const color = lineColorByLabel(stopLine);

      const badge = accessibilityBadge(stop);
      const roleLabel = isFirst ? "출발" : isLast ? "도착" : stop.isTransfer ? "환승" : "경유";

      let arrivalSection = "";
      if (stop.arrivalMeta) {
        const arrLine = stop.arrivalMeta.line || "";
        const arrColor = lineColorByLabel(arrLine);
        const dirStops = stop.arrivalMeta.directionStops || [];
        const dirLabel = dirStops.length > 0 ? ` (${dirStops.join(" · ")} 방면)` : "";
        const hasArrival = stop.realtimeArrival && stop.realtimeArrival.length > 0;
        arrivalSection = `
          <div class="arrival-header" style="color:${arrColor};border-left:3px solid ${arrColor};padding-left:8px;">
            ${arrLine} ${stop.name} 승차 시${dirLabel}
          </div>
          <ul class="arrival-list arrival-list--inline">
            ${hasArrival ? renderArrivalItems(stop.realtimeArrival, stop.name) : '<li class="arrival-item arrival-item--empty">도착정보 조회 중...</li>'}
          </ul>`;
      }

      return `
        <li class="stop ${stop.isTransfer ? "stop--transfer" : ""}" style="--line-color:${color}" data-stop-idx="${idx}">
          <div class="stop__dot"></div>
          <div class="stop__body">
            <div class="stop__top">
              <span class="stop__name">${stop.name}</span>
              <span class="line-badge" style="background:${color}">${stopLine}</span>
              <span class="line-badge">${roleLabel}</span>
              <span class="elevator-badge ${badge.ok ? "elevator-badge--ok" : "elevator-badge--bad"}">
                ${badge.text}
              </span>
            </div>
            ${stop.quickExit ? `<div class="quick-exit">🚪 ${(stop.quickExit.note || `${stop.quickExit.carNumber}번째 칸 ${stop.quickExit.doorNumber}번 문 쪽이 가장 가깝습니다.`).replace("하차 시", isFirst ? "승차 시" : "하차 시")}</div>` : ""}
            ${arrivalSection}
          </div>
        </li>
      `;
    })
    .join("");
}

function lineBadge(label) {
  return `<span class="line-badge" style="background:${lineColorByLabel(label)}">${label}</span>`;
}

const FALLBACK_PALETTE = [
  "#0068b7", "#e6186c", "#00a84d", "#ef7c1c", "#996cac",
  "#cd7c2f", "#747f00", "#0090d2", "#d4003b", "#8e44ad",
];

function lineColorByLabel(label) {
  if (!label) return FALLBACK_PALETTE[0];

  const metaList = Object.values(state.lineMeta);
  let entry = metaList.find((m) => m.name === label);
  if (!entry) {
    entry = metaList.find((m) => label.includes(m.name) || m.name.includes(label));
  }
  if (entry) return entry.color;

  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

function accessibilityBadge(stop) {
  const elevatorOk = Boolean(stop.elevator && stop.elevator.installed && stop.elevator.operational);
  const liftOk = Boolean(stop.lift && stop.lift.installed && stop.lift.operational);

  if (elevatorOk) return { ok: true, text: "♿ 엘리베이터 이용 가능" };
  if (liftOk) return { ok: true, text: "🦽 휠체어리프트 이용 가능" };

  const elevatorInstalled = stop.elevator && stop.elevator.installed;
  const liftInstalled = stop.lift && stop.lift.installed;
  if (elevatorInstalled === null && !liftInstalled) {
    return { ok: false, text: "ℹ 데이터 없음" };
  }
  if (elevatorInstalled && stop.elevator.operational === false) {
    return { ok: false, text: "⚠ 엘리베이터 고장" };
  }
  return { ok: false, text: "⚠ 엘리베이터·리프트 이용 불가" };
}

init();
