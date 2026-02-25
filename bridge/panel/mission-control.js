const state = {
  snapshot: null,
  selectedEventId: null,
  feedWindow: "now",
  feedLevel: "all",
  lastFetchOkAt: null,
  fetchError: null,
  serviceBusy: {},
  serviceBulkBusy: false,
};

// Human-friendly agent titles (fallbacks if the server doesn't provide name/subtitle)
const AGENT_LABELS = {
  'ops-bob': { name: 'Filippo (Architect)', subtitle: 'Orchestrator / operator-in-chief' },
  'mission-control': { name: 'Mission Control', subtitle: 'Ops brain (text) / routing' },
  'openclaw-server': { name: 'OpenClaw Server', subtitle: 'Gateway + routing + core services' },
  'voice-router': { name: 'Voice Router', subtitle: 'Realtime voice transport + routing' },
  'leap-runtime': { name: 'Leap Runtime', subtitle: 'Full-duplex voice runtime experiments' },
  'leap-io': { name: 'Leap I/O', subtitle: 'Audio I/O + streaming plumbing' },
  'eng-audio': { name: 'Eng Audio', subtitle: 'Audio pipeline engineering' },
  'visual-artist': { name: 'Visual Artist', subtitle: 'Flux / visuals generation' },
  'musician': { name: 'Musician', subtitle: 'ACE-Step / music generation' },
  'liquid-ai': { name: 'Rill', subtitle: 'Liquid AI specialist' },
  'sparky': { name: 'Sparky', subtitle: 'Fast prototyping / glue code' },
  'codex-3-high': { name: 'Codex-3-High', subtitle: 'Deep coding / analysis' },
  'agent-impl': { name: 'Agent Impl', subtitle: 'Implementation worker' },
};


const feedWindowOptions = [
  { id: "now", label: "Now" },
  { id: "today", label: "Today" },
  { id: "all", label: "All" },
];

import { initVoiceCard } from './voice.js'

const tokenInput = document.getElementById("token");
tokenInput.value = localStorage.getItem("openclawBridgeToken") || "";
tokenInput.addEventListener("input", () => {
  localStorage.setItem("openclawBridgeToken", tokenInput.value);
});

document.getElementById("refresh").addEventListener("click", fetchSnapshot);
document.getElementById("feedLevel").addEventListener("change", (event) => {
  state.feedLevel = event.target.value;
  render();
});
document.getElementById("noteSubmit")?.addEventListener("click", submitNote);
document.getElementById("scheduleSave")?.addEventListener("click", submitSchedule);

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "x-bridge-token": tokenInput.value,
  };
}

function collapseStorageKey(cardId) {
  return `mc_card_collapsed_${cardId}`;
}

function initCollapsibleCards() {
  document.querySelectorAll(".card").forEach((card, index) => {
    if (card.dataset.collapseReady === "1") {
      return;
    }
    const cardId = card.dataset.cardId || card.className.split(/\s+/).find((cls) => cls !== "card") || `card_${index}`;
    card.dataset.cardId = cardId;
    card.dataset.collapseReady = "1";

    const heading = card.querySelector("h2");
    if (!heading) {
      return;
    }

    const header = document.createElement("div");
    header.className = "card-header";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "card-toggle";
    toggle.setAttribute("aria-expanded", "true");
    toggle.dataset.cardId = cardId;
    toggle.textContent = "Collapse";
    toggle.addEventListener("click", () => {
      const current = card.dataset.collapsed === "1";
      const next = !current;
      card.dataset.collapsed = next ? "1" : "0";
      toggle.textContent = next ? "Expand" : "Collapse";
      toggle.setAttribute("aria-expanded", next ? "false" : "true");
      localStorage.setItem(collapseStorageKey(cardId), next ? "1" : "0");
    });

    // Always mount the collapsible header at the card root so it stays visible even when collapsed.
    // Some cards (e.g. Live Feed) nest <h2> inside other elements; inserting relative to the
    // heading's parent can accidentally place the header inside the collapsible body.
    header.appendChild(heading);
    header.appendChild(toggle);
    card.insertBefore(header, card.firstChild);

    const body = document.createElement("div");
    body.className = "card-body";
    const children = Array.from(card.children);
    for (const child of children) {
      if (child === header) {
        continue;
      }
      body.appendChild(child);
    }
    card.appendChild(body);

    const stored = localStorage.getItem(collapseStorageKey(cardId));
    if (stored === "1") {
      card.dataset.collapsed = "1";
      toggle.textContent = "Expand";
      toggle.setAttribute("aria-expanded", "false");
    } else {
      card.dataset.collapsed = "0";
    }
  });
}

async function submitNote() {
  const noteTextEl = document.getElementById("noteText");
  const noteProjectEl = document.getElementById("noteProject");
  const noteRouteEl = document.getElementById("noteRoute");
  const noteNextHopEl = document.getElementById("noteNextHop");
  const noteTypeEl = document.getElementById("noteType");
  const output = document.getElementById("noteOutput");

  const text = String(noteTextEl?.value || "").trim();
  if (!text) {
    output.textContent = JSON.stringify({ ok: false, error: "Note text is required" }, null, 2);
    return;
  }

  const payload = {
    text,
    projectId: String(noteProjectEl?.value || "").trim(),
    routeTo: String(noteRouteEl?.value || "ops-bob"),
    nextHop: String(noteNextHopEl?.value || "tibo"),
    type: String(noteTypeEl?.value || "idea"),
    author: "mission-control",
  };

  try {
    const res = await fetch("/api/mission-control/note", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    output.textContent = JSON.stringify(data, null, 2);
    if (data.ok) {
      noteTextEl.value = "";
    }
    await fetchSnapshot();
  } catch (err) {
    output.textContent = JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2);
  }
}

async function submitSchedule() {
  const titleEl = document.getElementById("scheduleTitle");
  const whenEl = document.getElementById("scheduleWhen");
  const projectEl = document.getElementById("scheduleProject");
  const assigneeEl = document.getElementById("scheduleAssignee");
  const cronEl = document.getElementById("scheduleCron");
  const output = document.getElementById("scheduleOutput");

  const title = String(titleEl?.value || "").trim();
  if (!title) {
    output.textContent = JSON.stringify({ ok: false, error: "Schedule title is required" }, null, 2);
    return;
  }

  const nextRunAtLocal = String(whenEl?.value || "").trim();
  const nextRunAt = nextRunAtLocal ? new Date(nextRunAtLocal).toISOString() : "";
  const payload = {
    title,
    nextRunAt: nextRunAt || null,
    projectId: String(projectEl?.value || "").trim(),
    assignee: String(assigneeEl?.value || "").trim(),
    cron: String(cronEl?.value || "").trim(),
    notes: String(cronEl?.value || "").trim(),
  };

  try {
    const res = await fetch("/api/mission-control/schedule", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    output.textContent = JSON.stringify(data, null, 2);
    if (data.ok) {
      titleEl.value = "";
      whenEl.value = "";
      cronEl.value = "";
    }
    await fetchSnapshot();
  } catch (err) {
    output.textContent = JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2);
  }
}

async function ackIntake(intakeId, noteId, status, comment = "") {
  const output = document.getElementById("noteOutput");
  try {
    const res = await fetch("/api/mission-control/intake/ack", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        intakeId: intakeId || "",
        noteId: noteId || "",
        status,
        ackBy: "ops-bob",
        comment,
      }),
    });
    const data = await res.json();
    output.textContent = JSON.stringify(data, null, 2);
    await fetchSnapshot();
  } catch (err) {
    output.textContent = JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2);
  }
}

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTs(ts) {
  if (!ts) {
    return "n/a";
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    return "n/a";
  }
  return d.toLocaleString();
}

function fmtAgeFromMs(ms) {
  if (ms === null || ms === undefined) {
    return "n/a";
  }
  const sec = Math.floor(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function setFeedWindow(windowId) {
  state.feedWindow = windowId;
  renderFeedWindowControls();
  render();
}

function renderFeedWindowControls() {
  const root = document.getElementById("feedTimeControls");
  root.innerHTML = feedWindowOptions
    .map(
      (option) =>
        `<button class="${state.feedWindow === option.id ? "active" : ""}" data-window="${option.id}">${option.label}</button>`,
    )
    .join("");
  root.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => setFeedWindow(button.dataset.window));
  });
}

function dataBannerText(snapshot) {
  if (!snapshot) {
    return {
      cls: "error",
      text: "Data missing: cannot load Mission Control snapshot. Set Admin Token from `./scripts/openclaw-bridge secrets admin-token` and retry.",
    };
  }

  if (state.fetchError) {
    const syncTs = snapshot.health?.data?.lastSuccessfulSync;
    const sync = syncTs ? fmtTs(syncTs) : "unknown";
    const cmd = snapshot.health?.data?.resyncInstruction || "openclaw mission-control sync";
    return {
      cls: "error",
      text: `Data fetch failed (${state.fetchError}). Last successful sync: ${sync}. Resync: ${cmd}`,
    };
  }

  const data = snapshot.health?.data;
  if (!data) {
    return { cls: "", text: "" };
  }

  if (data.state === "missing") {
    return {
      cls: "error",
      text: `Data missing. Last successful sync: ${data.lastSuccessfulSync ? fmtTs(data.lastSuccessfulSync) : "never"}. Resync: ${data.resyncInstruction}`,
    };
  }

  if (data.state === "stale") {
    return {
      cls: "warn",
      text: `Data stale (${fmtAgeFromMs(data.dataAgeMs)} old). Last successful sync: ${data.lastSuccessfulSync ? fmtTs(data.lastSuccessfulSync) : "unknown"}. Resync: ${data.resyncInstruction}`,
    };
  }

  return { cls: "", text: "" };
}

function levelClass(level) {
  if (level === "error") {
    return "danger";
  }
  if (level === "warn") {
    return "warn-text";
  }
  return "info";
}

function serviceStateClass(service) {
  if (service?.state === "running") {
    return "ok";
  }
  if (service?.state === "stopped") {
    return "danger";
  }
  return "warn-text";
}

function channelValue(channel) {
  if (!channel || channel.ok === null) {
    return '<span class="warn-text">unknown</span>';
  }
  const status = channel.ok ? '<span class="ok">ok</span>' : '<span class="danger">down</span>';
  const extra = channel.latencyMs ? ` · ${channel.latencyMs}ms` : "";
  const failures = channel.sendFailures ? ` · fail/h ${channel.sendFailures}` : "";
  return status + extra + failures;
}

function hash32(input) {
  const str = String(input || "agent");
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function spriteDataUrl(agentId) {
  const seed = hash32(agentId);
  const palette = ["#101626", "#2e3f61", "#5dd2ff", "#f8b84e", "#ff6f6f", "#ffffff"];
  const size = 8;
  const scale = 6;
  const cells = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size / 2; x += 1) {
      const bit = (seed >> ((x + y * 3) % 24)) & 1;
      if (!bit) {
        continue;
      }
      const c = palette[(seed + x * 7 + y * 13) % palette.length];
      cells.push({ x, y, c });
      cells.push({ x: size - x - 1, y, c });
    }
  }
  let rects = `<rect width="${size * scale}" height="${size * scale}" fill="#0b1325"/>`;
  for (const cell of cells) {
    rects += `<rect x="${cell.x * scale}" y="${cell.y * scale}" width="${scale}" height="${scale}" fill="${cell.c}"/>`;
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size * scale}' height='${size * scale}' viewBox='0 0 ${size * scale} ${size * scale}'>${rects}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function projectStatusClass(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("block") || value.includes("risk")) {
    return "danger";
  }
  if (value.includes("progress") || value.includes("active")) {
    return "info";
  }
  if (value.includes("done") || value.includes("ship") || value.includes("ok")) {
    return "ok";
  }
  if (!value || value === "unknown") {
    return "warn-text";
  }
  return "info";
}

function filteredFeed(snapshot) {
  if (!snapshot) {
    return [];
  }
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const now = Date.now();
  const windowMinutes = snapshot.feed?.defaultWindowMinutes || 120;
  const nowCutoff = now - windowMinutes * 60 * 1000;
  const todayCutoff = new Date();
  todayCutoff.setHours(0, 0, 0, 0);

  return events.filter((event) => {
    if (state.feedLevel !== "all" && event.level !== state.feedLevel) {
      return false;
    }
    const tsMs = new Date(event.ts).getTime();
    if (state.feedWindow === "now" && tsMs < nowCutoff) {
      return false;
    }
    if (state.feedWindow === "today" && tsMs < todayCutoff.getTime()) {
      return false;
    }
    return true;
  });
}

function renderHealth(snapshot) {
  const healthGrid = document.getElementById("healthGrid");
  const alerts = document.getElementById("alerts");

  if (!snapshot) {
    healthGrid.innerHTML = '<div class="empty">No health snapshot yet.</div>';
    alerts.textContent = "";
    return;
  }

  const health = snapshot.health || {};
  const gateway = health.gateway || {};
  const data = health.data || {};

  const gatewayText = gateway.reachable
    ? `<span class="ok">reachable</span> · active clients ${gateway.activeClients || 0}`
    : '<span class="danger">unreachable</span>';

  const latencyText =
    health.latencyMs === null || health.latencyMs === undefined
      ? '<span class="warn-text">unknown</span>'
      : `<span class="info">${health.latencyMs}ms</span>`;

  const dataClass = data.state === "ok" ? "ok" : data.state === "stale" ? "warn-text" : "danger";

  healthGrid.innerHTML = `
    <div class="metric"><div class="label">Gateway</div><div class="value">${gatewayText}</div></div>
    <div class="metric"><div class="label">Telegram</div><div class="value">${channelValue(health.channels?.telegram)}</div></div>
    <div class="metric"><div class="label">Discord</div><div class="value">${channelValue(health.channels?.discord)}</div></div>
    <div class="metric"><div class="label">Latency</div><div class="value">${latencyText}</div></div>
    <div class="metric"><div class="label">Data Freshness</div><div class="value"><span class="${dataClass}">${esc(data.state || "unknown")}</span> · ${fmtAgeFromMs(data.dataAgeMs)}</div></div>
  `;

  const alertList = Array.isArray(health.alerts) ? health.alerts : [];
  if (alertList.length === 0) {
    alerts.innerHTML = "No active alerts.";
  } else {
    alerts.innerHTML = alertList
      .map((item) => `<div class="${levelClass(item.level)}">${esc(item.message)}</div>`)
      .join("");
  }
}

function renderAgents(snapshot) {
  const agentsRail = document.getElementById("agentsRail");
  const sessionsRail = document.getElementById("sessionsRail");

  if (!snapshot) {
    agentsRail.innerHTML = '<div class="empty">No agent data.</div>';
    sessionsRail.innerHTML = '<div class="empty">No sessions.</div>';
    return;
  }

  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (agents.length === 0) {
    agentsRail.innerHTML =
      '<div class="empty">No agents reported. Check `status.json` / `agents.json` and run resync.</div>';
  } else {
    agentsRail.innerHTML = agents
      .map((agent) => {
        const statusCls = agent.status === "active" ? "ok" : "warn-text";
        const contextText =
          agent.contextUsagePct === null || agent.contextUsagePct === undefined
            ? "ctx n/a"
            : `ctx ${agent.contextUsagePct}%`;
        const sprite = spriteDataUrl(agent.id);
        const avatar = agent.avatar || sprite;
        const fallback = AGENT_LABELS[agent.id] || {};
        const displayName = agent.name || fallback.name || agent.id;
        const sub = agent.subtitle || fallback.subtitle || '';
        const subtitle = sub ? `<div class="tiny">${esc(sub)}</div>` : "";
        return `
        <article class="agent-card" data-agent-id="${esc(agent.id)}">
          <img class="avatar" src="${esc(avatar)}" alt="${esc(agent.id)} avatar" onerror="this.onerror=null;this.src='${esc(sprite)}';" />
          <div class="agent-meta">
            <div class="row" style="justify-content:space-between;align-items:center;gap:8px;">
              <div class="name">${esc(displayName)}</div>
              <button class="talk-btn" data-talk-agent="${esc(agent.id)}" title="Route voice to this agent">Talk<span class="talk-dot idle" data-talk-dot="${esc(agent.id)}"></span><span class="talk-state" data-talk-state="${esc(agent.id)}">Idle</span></button>
            </div>
            ${subtitle}
            <div class="tiny ${statusCls}">${esc(agent.status || "idle")} · conns ${agent.activeConnections || 0}</div>
            <div class="tiny">${esc(agent.model || "model n/a")} · ${esc(contextText)}</div>
            <div class="rail-line"><strong>Now:</strong> ${esc(agent.assignment || "No assignment")}</div>
            <div class="rail-line"><strong>Last:</strong> ${esc(agent.lastMessage || "No messages")}</div>
            <div class="rail-line"><strong>Next:</strong> ${esc(agent.next || "Define next step")}</div>
          </div>
        </article>
      `;
      })
      .join("");
  }

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions.slice(0, 8) : [];
  const sessionsCount = Number(snapshot.sessionsSummary?.count ?? snapshot.sessions?.length ?? 0);
  const sessionsHeader = `<div class="tiny" style="margin-bottom:6px;">Sessions: <strong>${esc(String(sessionsCount))}</strong></div>`;
  if (sessions.length === 0) {
    sessionsRail.innerHTML = `${sessionsHeader}<div class="empty">No recent sessions.</div>`;
    return;
  }

  sessionsRail.innerHTML = sessionsHeader + sessions
    .map((session) => {
      const ctxCls =
        session.contextUsagePct >= 90 ? "danger" : session.contextUsagePct >= 75 ? "warn-text" : "ok";
      return `<div class="session-chip">
      <strong>${esc(session.id)}</strong> · ${esc(session.agentId || "agent?")} · ${esc(session.model || "model?")} · <span class="${ctxCls}">ctx ${session.contextUsagePct === null || session.contextUsagePct === undefined ? "n/a" : `${session.contextUsagePct}%`}</span> · ${esc(session.ts ? fmtTs(session.ts) : "n/a")}
    </div>`;
    })
    .join("");
}

function renderProjects(snapshot) {
  const root = document.getElementById("projectsList");
  if (!snapshot) {
    root.innerHTML = '<div class="empty">No project data.</div>';
    return;
  }

  const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  if (projects.length === 0) {
    root.innerHTML = '<div class="empty">No projects found. Add `projects.json` or `workspace/projects/*.md`.</div>';
    return;
  }

  root.innerHTML = projects
    .map(
      (project) => `<article class="list-item">
      <div class="title">${esc(project.title)}</div>
      <div class="meta"><span class="${projectStatusClass(project.status)}">${esc(project.status || "unknown")}</span> · phase ${esc(project.phase || "n/a")} · source ${esc(project.source || "state")}</div>
      <div class="next"><strong>Next:</strong> ${esc(project.next || "Define next action")}</div>
    </article>`,
    )
    .join("");
}

function renderMissions(snapshot) {
  const root = document.getElementById("missionCols");
  if (!snapshot) {
    root.innerHTML = '<div class="empty">No mission queue data.</div>';
    return;
  }

  const missions = Array.isArray(snapshot.missions) ? snapshot.missions : [];
  const cols = {
    todo: missions.filter((m) => m.status === "todo" || m.status === "backlog" || m.status === "queued"),
    in_progress: missions.filter((m) => m.status === "in_progress" || m.status === "active" || m.status === "doing"),
    done: missions.filter((m) => m.status === "done" || m.status === "complete" || m.status === "completed"),
  };

  function colHtml(title, items) {
    if (items.length === 0) {
      return `<section class="col"><h3>${title}</h3><div class="empty">Empty</div></section>`;
    }
    return `<section class="col"><h3>${title}</h3>${items
      .map(
        (item) => `
      <article class="list-item">
        <div class="title">${esc(item.title)}</div>
        <div class="meta">${esc(item.projectId || "no project")} · ${esc(item.agentId || "unassigned")} · ${esc(item.rawStatus || item.status || "todo")} · ${esc(item.source || "state")}</div>
        <div class="next"><strong>Next:</strong> ${esc(item.next || "n/a")}${item.dueAt ? ` · <strong>Due:</strong> ${esc(fmtTs(item.dueAt))}` : ""}</div>
      </article>
    `,
      )
      .join("")}</section>`;
  }

  root.innerHTML = [colHtml("Todo", cols.todo), colHtml("In Progress", cols.in_progress), colHtml("Done", cols.done)].join("");
}

function renderCalendar(snapshot) {
  const root = document.getElementById("calendarList");
  if (!snapshot) {
    root.innerHTML = '<div class="empty">No calendar data.</div>';
    return;
  }

  const nowMs = Date.now();
  const items = (Array.isArray(snapshot.calendar) ? snapshot.calendar : [])
    .filter((item) => item.start && new Date(item.start).getTime() >= nowMs - 72 * 60 * 60 * 1000)
    .slice(0, 20);

  if (items.length === 0) {
    root.innerHTML = '<div class="empty">No upcoming calendar items.</div>';
    return;
  }

  root.innerHTML = items
    .map(
      (item) => `
    <article class="list-item">
      <div class="title">${esc(item.title)}</div>
      <div class="meta">${esc(fmtTs(item.start))} · ${esc(item.kind || item.source || "event")} ${item.projectId ? `· ${esc(item.projectId)}` : ""}</div>
      <div class="next">${esc(item.notes || "")}</div>
    </article>
  `,
    )
    .join("");
}

function renderFeed(snapshot) {
  const listRoot = document.getElementById("feedList");
  const traceRoot = document.getElementById("feedTrace");

  if (!snapshot) {
    listRoot.innerHTML = '<div class="empty">No live feed.</div>';
    traceRoot.textContent = "Select an event to view trace details.";
    return;
  }

  const feed = filteredFeed(snapshot).slice(0, 160);
  if (feed.length === 0) {
    listRoot.innerHTML = '<div class="empty">No events for current filter.</div>';
    traceRoot.textContent = "Select an event to view trace details.";
    return;
  }

  if (!feed.some((event) => event.id === state.selectedEventId)) {
    state.selectedEventId = feed[0].id;
  }

  listRoot.innerHTML = feed
    .map((event) => {
      const cls = event.id === state.selectedEventId ? "list-item feed-item selected" : "list-item feed-item";
      return `<article class="${cls}" data-event-id="${esc(event.id)}">
      <div class="title"><span class="badge ${levelClass(event.level)}">${esc(event.level)}</span>${esc(event.message)}</div>
      <div class="meta">${esc(fmtTs(event.ts))} · ${esc(event.source)} · ${esc(event.eventType)}</div>
      <div class="meta">agent: ${esc(event.agentId || "n/a")} · session: ${esc(event.sessionId || "n/a")} · corr: ${esc(event.correlationId || "n/a")}</div>
    </article>`;
    })
    .join("");

  listRoot.querySelectorAll(".feed-item").forEach((node) => {
    node.addEventListener("click", () => {
      state.selectedEventId = node.dataset.eventId;
      renderFeed(snapshot);
    });
  });

  const selected = feed.find((event) => event.id === state.selectedEventId) || feed[0];
  traceRoot.textContent = JSON.stringify(selected, null, 2);
}

function renderActions(snapshot) {
  const root = document.getElementById("actionsList");
  if (!snapshot) {
    root.innerHTML = '<div class="empty">No actions loaded.</div>';
    return;
  }

  const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
  root.innerHTML = actions
    .map((action) => `<button class="action-btn" data-action-id="${esc(action.id)}">${esc(action.label)}</button>`)
    .join("");

  root.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      const actionId = button.dataset.actionId;
      const action = actions.find((item) => item.id === actionId);
      if (!action) {
        return;
      }
      if (!confirm(action.confirm || "Run action?")) {
        return;
      }
      button.disabled = true;
      try {
        const res = await fetch("/api/mission-control/action", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({ actionId }),
        });
        const data = await res.json();
        document.getElementById("actionOutput").textContent = JSON.stringify(data, null, 2);
        await fetchSnapshot();
      } catch (err) {
        document.getElementById("actionOutput").textContent = JSON.stringify(
          { error: String(err.message || err) },
          null,
          2,
        );
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderCoreServices(snapshot) {
  const summaryRoot = document.getElementById("servicesSummary");
  const controlsRoot = document.getElementById("servicesControls");
  const listRoot = document.getElementById("servicesList");
  const outputRoot = document.getElementById("serviceOutput");

  if (!snapshot) {
    summaryRoot.textContent = "";
    controlsRoot.innerHTML = "";
    listRoot.innerHTML = '<div class="empty">No service data yet.</div>';
    return;
  }

  const core = snapshot.coreServices || {};
  const services = Array.isArray(core.services) ? core.services : [];
  if (services.length === 0) {
    summaryRoot.textContent = "";
    controlsRoot.innerHTML = "";
    listRoot.innerHTML = '<div class="empty">No core services configured.</div>';
    return;
  }

  const requiredDown = services.filter((service) => service.required && service.running !== true);
  const summaryClass = requiredDown.length === 0 ? "ok" : "danger";
  summaryRoot.innerHTML = `<span class="${summaryClass}">${requiredDown.length === 0 ? "All required services running" : `${requiredDown.length} required service(s) down`}</span> · checked ${esc(fmtTs(core.checkedAt))}`;
  controlsRoot.innerHTML = `<button id="servicesStartRequired" ${state.serviceBulkBusy || requiredDown.length === 0 ? "disabled" : ""}>Start All Required Services</button>`;

  listRoot.innerHTML = services
    .map((service) => {
      const stateClass = serviceStateClass(service);
      const busy = Boolean(state.serviceBusy[service.id]);
      const toggleOp = service.running === true ? "stop" : "start";
      const toggleLabel = service.running === true ? "Stop" : "Start";
      const toggleConfirm = service.confirmations?.[toggleOp] || `${toggleLabel} ${service.label}?`;
      const restartConfirm = service.confirmations?.restart || `Restart ${service.label}?`;
      const toggleDisabled = state.serviceBulkBusy || busy || !service.controls?.[toggleOp];
      const restartDisabled = state.serviceBulkBusy || busy || !service.controls?.restart;

      return `<article class="service-row">
        <div class="service-meta">
          <div class="title">${esc(service.label)}</div>
          <div class="meta"><span class="${stateClass}">${esc(service.state || "unknown")}</span>${service.pid ? ` · pid ${esc(service.pid)}` : ""}${service.required ? " · required" : ""}</div>
          <div class="next">${esc(service.description || service.lastLine || "")}</div>
        </div>
        <div class="service-controls">
          <button data-service-id="${esc(service.id)}" data-op="${esc(toggleOp)}" data-confirm="${esc(toggleConfirm)}" ${toggleDisabled ? "disabled" : ""}>${esc(toggleLabel)}</button>
          <button data-service-id="${esc(service.id)}" data-op="restart" data-confirm="${esc(restartConfirm)}" ${restartDisabled ? "disabled" : ""}>Restart</button>
        </div>
      </article>`;
    })
    .join("");

  const startRequiredButton = document.getElementById("servicesStartRequired");
  if (startRequiredButton) {
    startRequiredButton.addEventListener("click", async () => {
      if (!confirm("Start all required services that are currently down?")) {
        return;
      }
      state.serviceBulkBusy = true;
      renderCoreServices(snapshot);
      try {
        const res = await fetch("/api/mission-control/services/start-required", {
          method: "POST",
          headers: apiHeaders(),
        });
        const data = await res.json();
        outputRoot.textContent = JSON.stringify(data, null, 2);
        if (data.status && state.snapshot) {
          state.snapshot.coreServices = data.status;
        }
      } catch (err) {
        outputRoot.textContent = JSON.stringify({ error: String(err.message || err) }, null, 2);
      } finally {
        state.serviceBulkBusy = false;
        render();
      }
    });
  }

  listRoot.querySelectorAll("button[data-service-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const serviceId = button.dataset.serviceId;
      const operation = button.dataset.op;
      if (!serviceId || !operation) {
        return;
      }
      const confirmText = button.dataset.confirm || "Run service action?";
      if (!confirm(confirmText)) {
        return;
      }

      state.serviceBusy[serviceId] = true;
      renderCoreServices(snapshot);

      try {
        const res = await fetch("/api/mission-control/service", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({ serviceId, operation }),
        });
        const data = await res.json();
        outputRoot.textContent = JSON.stringify(data, null, 2);
        if (data.status && state.snapshot) {
          state.snapshot.coreServices = data.status;
        }
      } catch (err) {
        outputRoot.textContent = JSON.stringify({ error: String(err.message || err) }, null, 2);
      } finally {
        delete state.serviceBusy[serviceId];
        render();
      }
    });
  });
}

function renderNotes(snapshot) {
  const root = document.getElementById("notesList");
  if (!root) {
    return;
  }
  if (!snapshot) {
    root.innerHTML = '<div class="empty">No notes yet.</div>';
    return;
  }
  const intake = Array.isArray(snapshot.intake) ? snapshot.intake : [];
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
  const rows = intake.length > 0 ? intake : notes;
  if (rows.length === 0) {
    root.innerHTML = '<div class="empty">No notes posted yet.</div>';
    return;
  }
  root.innerHTML = rows
    .slice(0, 30)
    .map(
      (note) => `<article class="list-item">
      <div class="title">${esc(note.type || "note")} · ${esc(note.author || note.ackBy || "operator")} <span class="badge ${note.status === "accepted" ? "ok" : note.status === "rejected" ? "danger" : "info"}">${esc(note.status || "new")}</span></div>
      <div class="meta">${esc(fmtTs(note.updatedAt || note.ts))} · route ${esc(note.route || `${note.routeTo || "ops-bob"}->${note.nextHop || "tibo"}`)}${note.projectId ? ` · ${esc(note.projectId)}` : ""}</div>
      <div class="next">${esc(note.summary || note.text || "")}</div>
      <div class="controls">
        <button class="tiny-btn intake-ack" data-intake-id="${esc(note.intakeId || "")}" data-note-id="${esc(note.noteId || note.id || "")}" data-status="received">Received</button>
        <button class="tiny-btn intake-ack" data-intake-id="${esc(note.intakeId || "")}" data-note-id="${esc(note.noteId || note.id || "")}" data-status="triaged">Triaged</button>
        <button class="tiny-btn intake-ack" data-intake-id="${esc(note.intakeId || "")}" data-note-id="${esc(note.noteId || note.id || "")}" data-status="sent_to_tibo">Sent->Tibo</button>
        <button class="tiny-btn intake-ack" data-intake-id="${esc(note.intakeId || "")}" data-note-id="${esc(note.noteId || note.id || "")}" data-status="accepted">Accept</button>
        <button class="tiny-btn intake-ack" data-intake-id="${esc(note.intakeId || "")}" data-note-id="${esc(note.noteId || note.id || "")}" data-status="rejected">Reject</button>
      </div>
    </article>`,
    )
    .join("");

  root.querySelectorAll(".intake-ack").forEach((button) => {
    button.addEventListener("click", async () => {
      const status = button.dataset.status;
      const intakeId = button.dataset.intakeId || "";
      const noteId = button.dataset.noteId || "";
      const comment = window.prompt("Optional ACK comment:", "") || "";
      await ackIntake(intakeId, noteId, status, comment);
    });
  });
}

function render() {
  const snapshot = state.snapshot;

  const banner = document.getElementById("dataBanner");
  const bannerData = dataBannerText(snapshot);
  banner.className = `banner ${bannerData.cls || ""}`;
  banner.textContent = bannerData.text || "";

  const lastUpdated = document.getElementById("lastUpdated");
  lastUpdated.textContent = snapshot ? `Snapshot: ${fmtTs(snapshot.ts)}` : "Snapshot: n/a";

  renderHealth(snapshot);
  renderAgents(snapshot);
  renderProjects(snapshot);
  renderMissions(snapshot);
  renderCalendar(snapshot);
  renderFeed(snapshot);
  renderCoreServices(snapshot);
  renderNotes(snapshot);
  renderActions(snapshot);
}

async function fetchSnapshot() {
  try {
    const res = await fetch("/api/mission-control/snapshot", { headers: apiHeaders() });
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error("Unauthorized (set Admin Token)");
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    state.snapshot = body;
    state.fetchError = null;
    state.lastFetchOkAt = new Date().toISOString();
    render();
  } catch (err) {
    state.fetchError = String(err.message || err);
    render();
  }
}

renderFeedWindowControls();
initCollapsibleCards();
initVoiceCard();
render();
fetchSnapshot();
setInterval(fetchSnapshot, 3000);
