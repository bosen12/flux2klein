const cardsEl = document.getElementById("cards");
const logPanel = document.getElementById("logPanel");
const logTitle = document.getElementById("logTitle");
const logBody = document.getElementById("logBody");
document.getElementById("logClose").onclick = () => { logPanel.hidden = true; };

let busy = new Set();

async function api(path) {
  const r = await fetch(path, { method: path.startsWith("/api/start") || path.startsWith("/api/stop") ? "POST" : "GET" });
  return r.json();
}

function render(status) {
  cardsEl.innerHTML = "";
  for (const key of Object.keys(status)) {
    const s = status[key];
    const card = document.createElement("div");
    card.className = "card";

    const badgeClass = !s.running ? "off" : (s.managed_by_dashboard ? "on" : "ext");
    const badgeText = !s.running ? "已停止" : (s.managed_by_dashboard ? "運行中" : "運行中（外部啟動）");

    card.innerHTML = `
      <div class="card-head">
        <h2>${s.label}</h2>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="meta">port ${s.port}</div>
      <div class="actions">
        <button class="btn-start" data-act="start" data-key="${key}" ${s.running ? "disabled" : ""}>啟動</button>
        <button class="btn-stop" data-act="stop" data-key="${key}" ${s.running ? "" : "disabled"}>停止</button>
        <button class="btn-open" data-act="open" data-url="${s.url}" ${s.running ? "" : "disabled"}>開啟</button>
        <button class="btn-log" data-act="log" data-key="${key}" data-label="${s.label}">記錄</button>
      </div>
    `;
    cardsEl.appendChild(card);
  }
}

cardsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "open") {
    window.open(btn.dataset.url, "_blank");
    return;
  }
  if (act === "log") {
    const key = btn.dataset.key;
    logTitle.textContent = `${btn.dataset.label} — 記錄`;
    logBody.textContent = "載入中...";
    logPanel.hidden = false;
    const r = await api(`/api/logs?service=${key}`);
    logBody.textContent = (r.lines || []).join("\n") || "（沒有記錄）";
    logBody.scrollTop = logBody.scrollHeight;
    return;
  }
  if (act === "start" || act === "stop") {
    const key = btn.dataset.key;
    if (busy.has(key)) return;
    busy.add(key);
    btn.disabled = true;
    try {
      await api(`/api/${act}?service=${key}`);
    } finally {
      busy.delete(key);
      refresh();
    }
  }
});

async function refresh() {
  try {
    const status = await api("/api/status");
    render(status);
  } catch (e) {
    // 忽略單次失敗，下一輪再試
  }
}

refresh();
setInterval(refresh, 3000);
