const MQTT_TOPIC = "awumii/status/1bec2409314ba39f47f4db73b81bdb3a0af2a9c3805d5e63";
const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const MAX_BARS = 60;
const STALE_THRESHOLD_SEC = 45;

// Progi pingu (ms) oraz wieku handshake WireGuard (s)
const LATENCY_WARN_MS = 250;
const LATENCY_CRIT_MS = 650;
const WG_HS_WARN_SEC = 135;

const THEMES = [
  { id: "phosphor", label: "CRT: P31_GREEN" },
  { id: "amber", label: "CRT: P3_AMBER" },
  { id: "ice", label: "TERM: ICE_MONO" }
];

let lastVpsTs = null;
let lastEndpoints = null;

const dom = {
  connBox: document.getElementById("conn-box"),
  connText: document.getElementById("conn-text"),
  banner: document.getElementById("global-banner"),
  bannerTag: document.getElementById("banner-tag"),
  bannerMsg: document.getElementById("banner-msg"),
  app: document.getElementById("app"),
  incidentsList: document.getElementById("incidents-list"),
  incidentWindow: document.getElementById("incident-window"),
  lastUpdate: document.getElementById("last-update"),
  statOnline: document.getElementById("stat-online"),
  statUptime: document.getElementById("stat-uptime"),
  statLatency: document.getElementById("stat-latency"),
  statIncidents: document.getElementById("stat-incidents"),
  tooltip: document.getElementById("tooltip"),
  themeBtn: document.getElementById("theme-toggle")
};

(function initTheme() {
  const saved = localStorage.getItem("awumii_crt_theme") || "phosphor";
  applyTheme(saved);
  dom.themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || "phosphor";
    const idx = THEMES.findIndex(t => t.id === cur);
    const next = THEMES[(idx + 1) % THEMES.length];
    applyTheme(next.id);
  });
})();

function applyTheme(id) {
  const found = THEMES.find(t => t.id === id) || THEMES[0];
  document.documentElement.dataset.theme = found.id;
  dom.themeBtn.textContent = found.label;
  localStorage.setItem("awumii_crt_theme", found.id);
}

const client = mqtt.connect(BROKER_URL, {
  clientId: "awumii_tui_" + Math.random().toString(16).slice(2, 10),
  clean: true,
  reconnectPeriod: 3000
});

client.on("connect", () => {
  dom.connBox.className = "conn-pill connected";
  dom.connText.textContent = "WSS_LIVE";
  client.subscribe(MQTT_TOPIC);
});

client.on("reconnect", () => {
  dom.connBox.className = "conn-pill";
  dom.connText.textContent = "RECONNECT";
});

client.on("error", () => {
  dom.connBox.className = "conn-pill error";
  dom.connText.textContent = "WSS_ERR";
});

client.on("message", (_topic, payload) => {
  try {
    const parsed = JSON.parse(payload.toString());
    lastVpsTs = parsed.vps_ts || Math.floor(Date.now() / 1000);
    lastEndpoints = parsed.endpoints || [];
    if (dom.incidentWindow) {
      dom.incidentWindow.textContent = `OKNO: OSTATNIE ${parsed.window_hours || 24}H (60 × 24 MIN)`;
    }
    renderDashboard(lastEndpoints);
    checkHeartbeat();
  } catch (err) {
    console.error("JSON parse error:", err);
  }
});

setInterval(checkHeartbeat, 1000);

function checkHeartbeat() {
  if (!lastVpsTs || !lastEndpoints) return;
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - lastVpsTs);

  if (ageSec > STALE_THRESHOLD_SEC) {
    dom.banner.className = "status-bar degraded";
    dom.bannerTag.textContent = "[ CRIT ]";
    dom.bannerMsg.textContent = `BRAK PULSU Z WĘZŁA VPS (ostatni kontakt: ${formatDuration(ageSec)} temu) — dane poniżej są zamrożone!`;
    dom.app.style.opacity = "0.5";
  } else {
    dom.app.style.opacity = "1";
  }
}

function renderDashboard(endpoints) {
  let onlineCount = 0;
  let uptimeSum = 0;
  let uptimeCount = 0;
  const currentLatencies = [];

  const groups = {};
  const allIncidents = [];

  endpoints.forEach(ep => {
    const groupName = ep.group || "Inne";
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(ep);

    const last = ep.last;
    if (last && last.success) {
      onlineCount++;
      if (ep.key !== "wg-hs" && typeof last.duration === "number" && last.duration > 0) {
        currentLatencies.push(last.duration);
      }
    }

    if (typeof ep.uptime24h === "number") {
      uptimeSum += ep.uptime24h;
      uptimeCount++;
    }

    if (Array.isArray(ep.incidents)) {
      ep.incidents.forEach(inc => {
        allIncidents.push({
          ...inc,
          service: ep.name,
          group: groupName
        });
      });
    }
  });

  allIncidents.sort((a, b) => {
    if (a.ongoing !== b.ongoing) return a.ongoing ? -1 : 1;
    return new Date(b.start) - new Date(a.start);
  });

  const allUp = onlineCount === endpoints.length && endpoints.length > 0;
  if (allUp) {
    dom.banner.className = "status-bar all-ok";
    dom.bannerTag.textContent = "[  OK  ]";
    dom.bannerMsg.textContent = "Wszystkie systemy operacyjne — brak wykrytych anomalii.";
  } else {
    const downCount = endpoints.length - onlineCount;
    dom.banner.className = "status-bar degraded";
    dom.bannerTag.textContent = "[ WARN ]";
    dom.bannerMsg.textContent = `Degradacja usług: ${downCount} z ${endpoints.length} komponentów OFFLINE.`;
  }

  const avgUptime = uptimeCount > 0 ? (uptimeSum / uptimeCount).toFixed(2) : "0.00";
  const medianLatency = calcMedian(currentLatencies);

  dom.statOnline.textContent = `${onlineCount}/${endpoints.length}`;
  dom.statOnline.style.color = allUp ? "var(--ok)" : "var(--fail)";
  dom.statUptime.textContent = `${avgUptime}%`;
  dom.statLatency.textContent = `${medianLatency} ms`;
  dom.statLatency.style.color = medianLatency > LATENCY_WARN_MS ? "var(--warn)" : "var(--fg)";
  dom.statIncidents.textContent = allIncidents.length;
  dom.statIncidents.style.color = allIncidents.some(i => i.ongoing) ? "var(--fail)" : "var(--fg)";

  dom.app.innerHTML = "";
  for (const [groupName, items] of Object.entries(groups)) {
    const panel = document.createElement("section");
    panel.className = "group-panel";

    const groupOnline = items.filter(i => i.last?.success).length;
    panel.innerHTML = `
      <div class="panel-bar">
        <span>:: ${escapeHtml(groupName)}</span>
        <span>${groupOnline}/${items.length} UP</span>
      </div>
      <div class="srv-table-head">
        <span>STAN</span>
        <span>USŁUGA</span>
        <span>HISTORIA 24H (60 × 24M)</span>
        <span>UPTIME</span>
        <span>PING</span>
      </div>
    `;

    items.forEach(ep => {
      panel.appendChild(createServiceRow(ep));
    });

    dom.app.appendChild(panel);
  }

  renderIncidents(allIncidents);

  const syncTime = lastVpsTs
    ? new Date(lastVpsTs * 1000).toLocaleTimeString("pl-PL")
    : new Date().toLocaleTimeString("pl-PL");
  dom.lastUpdate.textContent = `VPS_HEARTBEAT: ${syncTime}`;
}

function createServiceRow(ep) {
  const last = ep.last;
  const isUp = Boolean(last && last.success);
  const isWgHs = ep.key === "wg-hs";
  const unit = isWgHs ? "s" : "ms";
  const nowVal = last && typeof last.duration === "number" ? last.duration : 0;
  const uptimePct = typeof ep.uptime24h === "number" ? ep.uptime24h.toFixed(1) : "0.0";

  let stateClass = "ok";
  let stateLabel = "[ OK ]";
  if (!isUp) {
    stateClass = "down";
    stateLabel = "[FAIL]";
  } else if (!isWgHs && nowVal >= LATENCY_CRIT_MS) {
    stateClass = "down";
    stateLabel = "[LAG!]";
  } else if ((!isWgHs && nowVal >= LATENCY_WARN_MS) || (isWgHs && nowVal >= WG_HS_WARN_SEC)) {
    stateClass = "slow";
    stateLabel = "[SLOW]";
  }

  let protoText = isWgHs ? "WG_L3" : "TCP/ICMP";
  if (!isWgHs && last && typeof last.status === "number" && last.status > 0) {
    protoText = `HTTP ${last.status}`;
  } else if (!isWgHs && last && !last.success) {
    protoText = "TIMEOUT";
  }

  const buckets = Array.isArray(ep.buckets) ? ep.buckets.slice(-MAX_BARS) : [];
  const padded = Array(Math.max(0, MAX_BARS - buckets.length)).fill(null).concat(buckets);

  const validBuckets = buckets.filter(Boolean);
  const avg24 = validBuckets.length > 0
    ? Math.round(validBuckets.reduce((a, b) => a + b.duration, 0) / validBuckets.length)
    : 0;
  const max24 = validBuckets.length > 0
    ? Math.max(...validBuckets.map(b => b.duration))
    : 0;

  const row = document.createElement("div");
  row.className = "srv-row";

  const mainLine = document.createElement("div");
  mainLine.className = "srv-main";

  const barsContainer = document.createElement("div");
  barsContainer.className = "spark-bars";

  padded.forEach(b => {
    const bar = document.createElement("div");
    if (!b) {
      bar.className = "bar";
      bar.dataset.tip = "Brak pomiarów w tym 24-min oknie";
    } else {
      const val = typeof b.duration === "number" ? b.duration : 0;
      const tier = classifyBar(b.success, val, isWgHs);
      bar.className = `bar ${tier.cls}`;
      bar.style.height = `${tier.heightPct}%`;

      const tStart = formatTimeHM(b.b_start);
      const tEnd = formatTimeHM(b.b_end);
      const ratio = `${b.ok}/${b.total} OK`;
      const durPart = isWgHs ? `śr. HS: ${val}s` : `śr. ${val} ms`;
      const errPart = !b.success && b.error ? ` | ${b.error}` : "";
      bar.dataset.tip = `[${tStart}–${tEnd}] ${ratio} | ${durPart}${errPart}`;
    }
    barsContainer.appendChild(bar);
  });

  const pingText = !isUp ? "TIMEOUT" : `${nowVal} ${unit}`;
  const pingTip = isWgHs
    ? `Teraz: ${nowVal}s | Średnia 24h: ${avg24}s | Max 24h: ${max24}s`
    : `Teraz: ${nowVal} ms | Średnia 24h: ${avg24} ms | Max kubełka 24h: ${max24} ms`;

  mainLine.innerHTML = `
    <span class="state-pill ${stateClass}">${stateLabel}</span>
    <div class="srv-ident">
      <span class="srv-name">${escapeHtml(ep.name)}</span>
      <span class="srv-proto ${isUp ? "" : "err"}">${protoText}</span>
    </div>
  `;
  mainLine.appendChild(barsContainer);

  const uptimeEl = document.createElement("span");
  uptimeEl.className = "srv-uptime";
  uptimeEl.textContent = `${uptimePct}%`;

  const pingEl = document.createElement("span");
  pingEl.className = `srv-ping ${stateClass}`;
  pingEl.textContent = pingText;
  pingEl.dataset.tip = pingTip;

  mainLine.appendChild(uptimeEl);
  mainLine.appendChild(pingEl);
  row.appendChild(mainLine);

  if (!isUp && last) {
    const reason = getFailureReason(last) || (last.status > 0 ? `Otrzymano kod HTTP ${last.status}` : "Brak odpowiedzi z hosta docelowego");
    const errDiv = document.createElement("div");
    errDiv.className = "srv-err-line";
    errDiv.textContent = `> ERR: ${reason}`;
    row.appendChild(errDiv);
  }

  return row;
}

function classifyBar(success, val, isWgHs) {
  if (!success) {
    return { cls: "crit", heightPct: 100 };
  }
  if (isWgHs) {
    const pct = Math.min(100, Math.max(25, Math.round((val / 150) * 100)));
    return { cls: val >= WG_HS_WARN_SEC ? "slow" : "ok", heightPct: pct };
  }
  const clamped = Math.max(10, Math.min(1500, val));
  const norm = Math.log10(clamped / 10) / Math.log10(150);
  const heightPct = Math.round(22 + norm * 78);

  if (val >= LATENCY_CRIT_MS) return { cls: "crit", heightPct: 100 };
  if (val >= LATENCY_WARN_MS) return { cls: "slow", heightPct };
  return { cls: "ok", heightPct };
}

function calcMedian(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? Math.round(sorted[mid])
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function getFailureReason(result) {
  if (!result || result.success) return "";
  const parts = [];
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    parts.push(result.errors.join("; "));
  }
  if (Array.isArray(result.failedConditions) && result.failedConditions.length > 0) {
    parts.push("warunek: " + result.failedConditions.join(", "));
  }
  return parts.join(" | ");
}

function renderIncidents(incidents) {
  if (incidents.length === 0) {
    dom.incidentsList.innerHTML = `<div class="log-empty">&gt; Brak zarejestrowanych incydentów w ostatnich 24 godzinach.</div>`;
    return;
  }

  dom.incidentsList.innerHTML = incidents.map(inc => {
    const startFmt = formatDateTime(inc.start);
    const endFmt = inc.ongoing ? "TERAZ" : formatDateTime(inc.end);
    const durSec = Math.max(0, Math.round((new Date(inc.end) - new Date(inc.start)) / 1000));
    const durText = formatDuration(durSec);
    const codeInfo = inc.lastStatus > 0 ? `HTTP ${inc.lastStatus}` : "TIMEOUT";

    return `
      <div class="log-entry ${inc.ongoing ? "ongoing" : ""}">
        <div class="log-entry-head">
          <span>[${escapeHtml(inc.group)}] ${escapeHtml(inc.service)}</span>
          <span class="log-tag ${inc.ongoing ? "ongoing" : "resolved"}">
            ${inc.ongoing ? "[ AKTYWNA AWARIA ]" : "[ ROZWIĄZANO ]"}
          </span>
        </div>
        <div class="log-entry-meta">
          <span>${startFmt} → ${endFmt} (${durText})</span>
          <span>Próby: ${inc.count}</span>
          <span>Kod: ${codeInfo}</span>
          <span>${escapeHtml(inc.reason)}</span>
        </div>
      </div>
    `;
  }).join("");
}

function formatTimeHM(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

document.addEventListener("mouseover", e => {
  const target = e.target.closest("[data-tip]");
  if (!target) return;
  dom.tooltip.textContent = target.dataset.tip;
  dom.tooltip.classList.remove("hidden");
});

document.addEventListener("mousemove", e => {
  if (dom.tooltip.classList.contains("hidden")) return;
  const x = Math.min(window.innerWidth - 350, e.clientX + 12);
  const y = Math.max(10, e.clientY - 36);
  dom.tooltip.style.left = `${x}px`;
  dom.tooltip.style.top = `${y}px`;
});

document.addEventListener("mouseout", e => {
  if (e.target.closest("[data-tip]")) {
    dom.tooltip.classList.add("hidden");
  }
});
