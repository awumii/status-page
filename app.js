const MQTT_TOPIC = "awumii/status/1bec2409314ba39f47f4db73b81bdb3a0af2a9c3805d5e63";
const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const MAX_BARS = 60; // Ile ostatnich słupków rysować na karcie

const dom = {
  dot: document.getElementById("conn-dot"),
  connText: document.getElementById("conn-text"),
  banner: document.getElementById("global-banner"),
  bannerTag: document.querySelector(".banner-tag"),
  bannerMsg: document.getElementById("banner-msg"),
  app: document.getElementById("app"),
  incidentsList: document.getElementById("incidents-list"),
  lastUpdate: document.getElementById("last-update"),
  statOnline: document.getElementById("stat-online"),
  statUptime: document.getElementById("stat-uptime"),
  statLatency: document.getElementById("stat-latency"),
  statIncidents: document.getElementById("stat-incidents"),
  tooltip: document.getElementById("tooltip")
};

const client = mqtt.connect(BROKER_URL, {
  clientId: "awumii_tui_" + Math.random().toString(16).slice(2, 10),
  clean: true,
  reconnectPeriod: 3000
});

client.on("connect", () => {
  dom.dot.className = "led connected";
  dom.connText.textContent = "LIVE // WSS_CONNECTED";
  client.subscribe(MQTT_TOPIC);
});

client.on("reconnect", () => {
  dom.dot.className = "led";
  dom.connText.textContent = "RECONNECTING...";
});

client.on("error", () => {
  dom.dot.className = "led error";
  dom.connText.textContent = "ERR // BROKER_FAIL";
});

client.on("message", (_topic, payload) => {
  try {
    const endpoints = JSON.parse(payload.toString());
    renderDashboard(endpoints);
  } catch (err) {
    console.error("JSON parse error:", err);
  }
});

function renderDashboard(endpoints) {
  let onlineCount = 0;
  let totalChecks = 0;
  let totalSuccess = 0;
  let latencySum = 0;
  let latencyCount = 0;

  const groups = {};
  const allIncidents = [];

  endpoints.forEach(ep => {
    const groupName = ep.group || "Inne";
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(ep);

    const results = ep.results || [];
    const last = results[results.length - 1];
    if (last && last.success) onlineCount++;

    results.forEach(r => {
      totalChecks++;
      if (r.success) {
        totalSuccess++;
        if (typeof r.duration === "number" && r.duration > 0) {
          latencySum += r.duration;
          latencyCount++;
        }
      }
    });

    // Wyciągamy incydenty (ciągi kolejnych nieudanych prób) dla danej usługi
    allIncidents.push(...extractIncidents(ep.name, groupName, results));
  });

  // Sortujemy incydenty od najnowszych (trwające zawsze na samej górze)
  allIncidents.sort((a, b) => {
    if (a.ongoing !== b.ongoing) return a.ongoing ? -1 : 1;
    return new Date(b.start) - new Date(a.start);
  });

  // Aktualizacja banera
  const allUp = onlineCount === endpoints.length && endpoints.length > 0;
  if (allUp) {
    dom.banner.className = "banner all-ok";
    dom.bannerTag.textContent = "[OK]";
    dom.bannerMsg.textContent = "Wszystkie systemy operacyjne — brak wykrytych anomalii.";
  } else {
    const downCount = endpoints.length - onlineCount;
    dom.banner.className = "banner degraded";
    dom.bannerTag.textContent = "[WARN]";
    dom.bannerMsg.textContent = `Wykryto degradację usług (${downCount} z ${endpoints.length} komponentów OFFLINE).`;
  }

  // Pasek statystyk globalnych
  const avgUptime = totalChecks > 0 ? ((totalSuccess / totalChecks) * 100).toFixed(2) : "0.00";
  const avgLatency = latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0;

  dom.statOnline.textContent = `${onlineCount}/${endpoints.length}`;
  dom.statOnline.style.color = allUp ? "var(--ok)" : "var(--fail)";
  dom.statUptime.textContent = `${avgUptime}%`;
  dom.statLatency.textContent = `${avgLatency} ms`;
  dom.statIncidents.textContent = allIncidents.length;
  dom.statIncidents.style.color = allIncidents.some(i => i.ongoing) ? "var(--fail)" : "var(--text)";

  // Renderowanie grup i kart usług
  dom.app.innerHTML = "";
  for (const [groupName, items] of Object.entries(groups)) {
    const groupEl = document.createElement("section");
    groupEl.className = "group-block";

    const groupOnline = items.filter(i => i.results?.at(-1)?.success).length;
    groupEl.innerHTML = `
      <div class="group-header">
        <span>// ${escapeHtml(groupName)}</span>
        <span>${groupOnline}/${items.length} UP</span>
      </div>
    `;

    items.forEach(ep => {
      groupEl.appendChild(createServiceCard(ep));
    });

    dom.app.appendChild(groupEl);
  }

  renderIncidents(allIncidents);

  const nowStr = new Date().toLocaleTimeString("pl-PL");
  dom.lastUpdate.textContent = `LAST_SYNC: ${nowStr}`;
}

function createServiceCard(ep) {
  const results = ep.results || [];
  const last = results[results.length - 1];
  const isUp = Boolean(last && last.success);

  // Obliczenia dla pojedynczej usługi
  const okResults = results.filter(r => r.success);
  const uptimePct = results.length > 0 ? ((okResults.length / results.length) * 100).toFixed(1) : "0.0";
  const durations = okResults.map(r => r.duration).filter(d => typeof d === "number");
  const avgMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const maxMs = durations.length > 0 ? Math.max(...durations) : 0;

  // Kod odpowiedzi z Gatusa (HTTP status lub TCP)
  let codeText = "TCP/ICMP";
  let codeClass = isUp ? "code-ok" : "code-err";
  if (last && typeof last.status === "number" && last.status > 0) {
    codeText = `HTTP ${last.status}`;
  } else if (last && !last.success) {
    codeText = "NO_RESP";
  }

  // Ostatnie MAX_BARS pomiarów
  const slice = results.slice(-MAX_BARS);
  const padded = Array(Math.max(0, MAX_BARS - slice.length)).fill(null).concat(slice);

  const card = document.createElement("article");
  card.className = `card ${isUp ? "is-up" : "is-down"}`;

  const barsContainer = document.createElement("div");
  barsContainer.className = "bars";

  padded.forEach(r => {
    const bar = document.createElement("div");
    if (!r) {
      bar.className = "bar";
      bar.dataset.tip = "Brak próbki w buforze";
    } else {
      bar.className = `bar ${r.success ? "up" : "down"}`;
      const time = new Date(r.timestamp).toLocaleTimeString("pl-PL");
      const statusPart = r.status > 0 ? `HTTP ${r.status}` : (r.success ? "CONNECTED" : "TIMEOUT/ERR");
      const errPart = getFailureReason(r);
      bar.dataset.tip = `[${time}] ${r.success ? "OK" : "FAIL"} | ${statusPart} | ${r.duration} ms${errPart ? " | " + errPart : ""}`;
    }
    barsContainer.appendChild(bar);
  });

  // Opis bieżącego błędu, jeśli usługa leży
  let errorBannerHtml = "";
  if (!isUp && last) {
    const reason = getFailureReason(last) || (last.status > 0 ? `Otrzymano nieoczekiwany kod HTTP ${last.status}` : "Brak odpowiedzi z hosta docelowego");
    errorBannerHtml = `<div class="error-line">&gt; ERR_DETAIL: ${escapeHtml(reason)}</div>`;
  }

  const firstTime = slice[0] ? new Date(slice[0].timestamp).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "--:--";
  const lastTime = last ? new Date(last.timestamp).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "--:--";

  card.innerHTML = `
    <div class="card-top">
      <div class="service-left">
        <span class="service-name">${escapeHtml(ep.name)}</span>
        <span class="http-badge ${codeClass}">${codeText}</span>
      </div>
      <div class="meta">
        <span class="meta-item">UP: <strong>${uptimePct}%</strong></span>
        <span class="meta-item">NOW: <strong>${last ? last.duration : 0}ms</strong></span>
        <span class="meta-item">AVG/MAX: <strong>${avgMs}/${maxMs}ms</strong></span>
        <span class="status-tag ${isUp ? "up" : "down"}">${isUp ? "ONLINE" : "OFFLINE"}</span>
      </div>
    </div>
  `;

  card.appendChild(barsContainer);

  const bottomRow = document.createElement("div");
  bottomRow.className = "card-bottom";
  bottomRow.innerHTML = `
    <span>${firstTime} (${slice.length} próbek)</span>
    <span>${lastTime}</span>
  `;
  card.appendChild(bottomRow);

  if (errorBannerHtml) {
    card.insertAdjacentHTML("beforeend", errorBannerHtml);
  }

  return card;
}

function getFailureReason(result) {
  if (!result || result.success) return "";
  const parts = [];
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    parts.push(result.errors.join("; "));
  }
  if (Array.isArray(result.failedConditions) && result.failedConditions.length > 0) {
    parts.push("niespełniony warunek: " + result.failedConditions.join(", "));
  }
  return parts.join(" | ");
}

function extractIncidents(serviceName, groupName, results) {
  const incidents = [];
  let current = null;

  results.forEach(r => {
    if (!r.success) {
      const reason = getFailureReason(r) || (r.status > 0 ? `HTTP ${r.status}` : "Connection failed");
      if (!current) {
        current = {
          service: serviceName,
          group: groupName,
          start: r.timestamp,
          end: r.timestamp,
          count: 1,
          lastStatus: r.status,
          reason: reason,
          ongoing: true
        };
      } else {
        current.end = r.timestamp;
        current.count++;
        if (r.status > 0) current.lastStatus = r.status;
        if (reason) current.reason = reason;
      }
    } else if (current) {
      current.end = r.timestamp;
      current.ongoing = false;
      incidents.push(current);
      current = null;
    }
  });

  if (current) {
    incidents.push(current);
  }

  return incidents;
}

function renderIncidents(incidents) {
  if (incidents.length === 0) {
    dom.incidentsList.innerHTML = `<div class="empty-log">&gt; Brak zarejestrowanych incydentów w bieżącym oknie telemetrycznym.</div>`;
    return;
  }

  dom.incidentsList.innerHTML = incidents.map(inc => {
    const startFmt = formatDateTime(inc.start);
    const endFmt = inc.ongoing ? "TERAZ" : formatDateTime(inc.end);
    const durSec = Math.max(0, Math.round((new Date(inc.end) - new Date(inc.start)) / 1000));
    const durText = formatDuration(durSec);
    const codeInfo = inc.lastStatus > 0 ? `Kod: HTTP ${inc.lastStatus}` : "Kod: Brak połączenia";

    return `
      <div class="incident-item ${inc.ongoing ? "ongoing" : ""}">
        <div class="incident-head">
          <span class="incident-title">[${escapeHtml(inc.group)}] ${escapeHtml(inc.service)}</span>
          <span class="incident-badge ${inc.ongoing ? "ongoing" : "resolved"}">
            ${inc.ongoing ? "AKTYWNA AWARIA" : "ROZWIĄZANO"}
          </span>
        </div>
        <div class="incident-details">
          <span>Czas: ${startFmt} → ${endFmt} (${durText})</span>
          <span>Nieudane próby: ${inc.count}</span>
          <span>${codeInfo}</span>
          <span>Powód: ${escapeHtml(inc.reason)}</span>
        </div>
      </div>
    `;
  }).join("");
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

// Obsługa własnego retro-tooltipa na paskach historii
document.addEventListener("mouseover", e => {
  const bar = e.target.closest(".bar");
  if (!bar || !bar.dataset.tip) return;
  dom.tooltip.textContent = bar.dataset.tip;
  dom.tooltip.classList.remove("hidden");
});

document.addEventListener("mousemove", e => {
  if (dom.tooltip.classList.contains("hidden")) return;
  const x = Math.min(window.innerWidth - 335, e.clientX + 12);
  const y = Math.max(10, e.clientY - 38);
  dom.tooltip.style.left = `${x}px`;
  dom.tooltip.style.top = `${y}px`;
});

document.addEventListener("mouseout", e => {
  if (e.target.closest(".bar")) {
    dom.tooltip.classList.add("hidden");
  }
});
