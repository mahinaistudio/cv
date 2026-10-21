/* team.js — Crickverse Team Mode client
   Two teams x 11 slots, personal wickets, shared overs, teammate view.
   The 1v1 game in script.js is not touched. */

// Same worker as script.js. Change both when promoting to production.
const TM_WS_URL = "wss://test.mahin-aistudio.workers.dev";

const TM = {
  ws: null,
  code: null,
  mode: null,              // create | join | spectate
  setupKind: "create",
  joined: false,
  pendingPick: false,
  connecting: false,
  disconnected: false,
  roomFull: false,
  leaving: false,

  state: null,
  lobby: null,
  result: null,
  break: null,
  tossCaller: null,
  tossResult: null,

  myUserId: null,
  myTeam: null,
  mySlot: null,
  myName: null,
  spectator: false,

  overs: 6,
  wickets: 2,
  createTries: 0,

  selected: [],
  locked: false,
  recFingers: [],
  recPanelOpen: false,
  recs: [],
  mateRole: null,
  mateFingers: [],

  slotRequest: null,
  subRequests: {},
  subWindow: null,

  lastBall: null,
  rematchRequest: null,
  scorecardOpen: false,
  squadsOpen: false,

  countdownTimer: null,
  msgTimer: null,
};

const TM_FINGER_NAMES = {
  thumb: "Thumb", index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky",
};

/* ══════════════════════════════════════════════════════════════════════
   Entry points from the home screen
   ══════════════════════════════════════════════════════════════════════ */

function tmEsc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function tmToken() {
  return localStorage.getItem("cv_token") || null;
}

function tmDisplayName() {
  return localStorage.getItem("cv_display_name")
      || localStorage.getItem("cv_username")
      || "Player";
}

function tmShowHome() {
  if (typeof switchTab === "function") switchTab("homeScreen", "navHome");
  else if (typeof showScreen === "function") showScreen("homeScreen");
}

function tmToast(msg, color) {
  if (typeof showToast === "function") {
    showToast(msg, color || "var(--accent)", "white", 1800);
    return;
  }
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;background:#1e293b;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function tmShowSetupError(msg) {
  const el = document.getElementById("tmSetupError");
  if (el) el.textContent = msg;
  else tmToast(msg, "var(--red)");
}

function tmGenerateCode() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

function tmShowTeamScreen() {
  if (typeof showScreen === "function") showScreen("teamScreen");
  else {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById("teamScreen").classList.add("active");
  }
}

function tmOpenSetup(kind) {
  if (!tmToken()) {
    if (typeof showAlert === "function") showAlert("Please log in first.", "🔒");
    else tmToast("Please log in first.", "var(--red)");
    return;
  }
  tmCloseSocket();
  tmResetState();
  TM.setupKind = kind || "create";
  TM.overs = TM.overs || 6;
  TM.wickets = TM.wickets || 2;
  tmShowTeamScreen();
  tmRender();
}

function tmQuickJoin() {
  const input = document.getElementById("tmHomeJoinCode");
  const code = (input?.value || "").trim();
  if (!/^\d{4}$/.test(code)) {
    tmOpenSetup("join");
    return;
  }
  tmStartJoin(code, "join");
}

function tmQuickSpectate() {
  const input = document.getElementById("tmHomeJoinCode");
  const code = (input?.value || "").trim();
  if (!/^\d{4}$/.test(code)) {
    tmOpenSetup("spectate");
    return;
  }
  tmStartJoin(code, "spectate");
}

function tmCreateRoom() {
  if (!tmToken()) {
    tmShowSetupError("Please log in first.");
    return;
  }
  const oversEl   = document.getElementById("tmOvers");
  const wicketsEl = document.getElementById("tmWickets");
  const overs     = parseInt(oversEl?.value || "6", 10);
  const wickets   = parseInt(wicketsEl?.value || "2", 10);
  if (!Number.isFinite(overs) || overs < 1 || overs > 50) {
    tmShowSetupError("Overs must be between 1 and 50.");
    return;
  }
  if (!Number.isFinite(wickets) || wickets < 1 || wickets > 10) {
    tmShowSetupError("Wickets per player must be between 1 and 10.");
    return;
  }
  TM.overs = overs;
  TM.wickets = wickets;
  TM.createTries = 0;
  tmStartJoin(tmGenerateCode(), "create");
}

function tmJoinRoom() {
  const code = (document.getElementById("tmJoinCode")?.value || "").trim();
  if (!/^\d{4}$/.test(code)) {
    tmShowSetupError("Enter the 4-digit room code.");
    return;
  }
  tmStartJoin(code, "join");
}

function tmSpectate() {
  const code = (document.getElementById("tmJoinCode")?.value || "").trim();
  if (!/^\d{4}$/.test(code)) {
    tmShowSetupError("Enter the 4-digit room code.");
    return;
  }
  tmStartJoin(code, "spectate");
}

function tmStartJoin(code, mode) {
  if (!tmToken()) {
    tmShowSetupError("Please log in first.");
    return;
  }
  tmCloseSocket();
  TM.code = code;
  TM.mode = mode;
  TM.leaving = false;
  TM.joined = false;
  TM.pendingPick = false;
  TM.connecting = true;
  TM.disconnected = false;
  TM.roomFull = false;
  TM.state = null;
  TM.lobby = null;
  TM.result = null;
  TM.break = null;
  TM.tossCaller = null;
  TM.tossResult = null;
  TM.myUserId = null;
  TM.myTeam = null;
  TM.mySlot = null;
  TM.myName = null;
  TM.selected = [];
  TM.locked = false;
  TM.recFingers = [];
  TM.recPanelOpen = false;
  TM.recs = [];
  TM.mateRole = null;
  TM.mateFingers = [];
  TM.lastBall = null;
  TM.subWindow = null;
  TM.subRequests = {};
  TM.slotRequest = null;
  TM.rematchRequest = null;
  TM.scorecardOpen = false;
  TM.squadsOpen = false;
  TM.spectator = mode === "spectate";
  TM.createTries = 0;
  tmShowTeamScreen();
  tmRender();
  tmConnect(mode);
}

/* ══════════════════════════════════════════════════════════════════════
   Socket
   ══════════════════════════════════════════════════════════════════════ */

function tmCloseSocket() {
  if (TM.ws) {
    try { TM.ws.close(); } catch (_) {}
    TM.ws = null;
  }
}

function tmConnect(mode) {
  tmCloseSocket();
  TM.mode = mode;
  const ws = new WebSocket(TM_WS_URL + "/team/" + TM.code);
  TM.ws = ws;

  ws.onopen = () => {
    if (TM.ws !== ws) return;
    const name = tmDisplayName();
    if (mode === "create") {
      ws.send(JSON.stringify({
        type: "TM_CREATE_ROOM",
        payload: { playerName: name, overs: TM.overs, wickets: TM.wickets, token: tmToken() },
      }));
    } else {
      ws.send(JSON.stringify({
        type: "TM_JOIN",
        payload: { playerName: name, token: tmToken(), spectate: mode === "spectate" },
      }));
    }
  };

  ws.onmessage = (event) => {
    if (TM.ws !== ws) return;
    let data;
    try { data = JSON.parse(event.data); } catch (_) { return; }
    tmHandleMessage(data);
  };

  ws.onclose = () => {
    // Ignore the late close event from a socket we already replaced.
    if (TM.ws !== ws) return;
    TM.connecting = false;
    if (TM.leaving) return;
    if (TM.joined) {
      TM.disconnected = true;
      tmRender();
    }
  };

  ws.onerror = () => {
    if (TM.ws !== ws) return;
    if (!TM.joined) {
      TM.connecting = false;
      TM.roomFull = false;
      tmShowSetupError("Could not connect. Check the code and try again.");
      tmRender();
    }
  };
}

function tmReconnect() {
  TM.disconnected = false;
  TM.joined = false;
  TM.connecting = true;
  TM.state = null;
  TM.lobby = null;
  TM.subWindow = null;
  TM.result = null;
  tmRender();
  tmConnect(TM.mode === "spectate" ? "spectate" : "join");
}

function tmSpectateSameRoom() {
  TM.mode = "spectate";
  TM.spectator = true;
  TM.roomFull = false;
  TM.joined = false;
  TM.connecting = true;
  TM.state = null;
  TM.lobby = null;
  tmRender();
  tmConnect("spectate");
}

function tmLeave(force) {
  const phase = TM.state?.phase;
  const live = phase === "play" || phase === "toss" || phase === "decision" || phase === "inningsBreak";
  if (!force && live && !confirm("Leave the team match? Your team will continue with a substitute.")) {
    return;
  }
  TM.leaving = true;
  tmCloseSocket();
  tmResetState();
  tmShowHome();
}

function tmGoHome() {
  tmLeave(true);
}

function tmResetState() {
  if (TM.countdownTimer) { clearInterval(TM.countdownTimer); TM.countdownTimer = null; }
  if (TM.msgTimer) { clearTimeout(TM.msgTimer); TM.msgTimer = null; }
  TM.code = null;
  TM.mode = null;
  TM.joined = false;
  TM.pendingPick = false;
  TM.connecting = false;
  TM.disconnected = false;
  TM.roomFull = false;
  TM.leaving = false;
  TM.state = null;
  TM.lobby = null;
  TM.result = null;
  TM.break = null;
  TM.tossCaller = null;
  TM.tossResult = null;
  TM.myUserId = null;
  TM.myTeam = null;
  TM.mySlot = null;
  TM.myName = null;
  TM.spectator = false;
  TM.selected = [];
  TM.locked = false;
  TM.recFingers = [];
  TM.recPanelOpen = false;
  TM.recs = [];
  TM.mateRole = null;
  TM.mateFingers = [];
  TM.slotRequest = null;
  TM.subRequests = {};
  TM.subWindow = null;
  TM.lastBall = null;
  TM.rematchRequest = null;
  TM.scorecardOpen = false;
  TM.squadsOpen = false;
  TM.createTries = 0;
}

/* ══════════════════════════════════════════════════════════════════════
   Server messages
   ══════════════════════════════════════════════════════════════════════ */

function tmHandleMessage(data) {
  switch (data.type) {
    case "TM_JOINED": {
      TM.connecting = false;
      TM.joined = true;
      TM.roomFull = false;
      TM.disconnected = false;
      TM.myUserId = data.payload.userId || TM.myUserId;
      TM.myTeam   = data.payload.team || null;
      TM.mySlot   = data.payload.slot || null;
      TM.myName   = data.payload.name || tmDisplayName();
      TM.pendingPick = !!data.payload.mustPick;
      TM.spectator = data.payload.slot === "SPECTATOR" || !!data.payload.spectator;
      if (data.payload.isReconnect) tmToast("Reconnected to the room", "var(--green)");
      tmRender();
      break;
    }

    case "TM_LOBBY": {
      TM.lobby = data.payload;
      // A slot swap can move us without a new TM_JOINED message.
      if (TM.myUserId) {
        for (const team of ["A", "B"]) {
          const mine = (data.payload.teams?.[team] || []).find(s => !s.empty && s.userId === TM.myUserId);
          if (mine) {
            TM.mySlot = mine.slotKey;
            TM.myTeam = team;
            break;
          }
        }
      }
      if (TM.state == null || TM.state.phase === "lobby" || TM.pendingPick) {
        tmRender();
      }
      break;
    }

    case "TM_STATE": {
      TM.state = data.payload;
      TM.joined = true;
      TM.connecting = false;
      TM.pendingPick = false;
      TM.roomFull = false;
      TM.disconnected = false;
      TM.myUserId = data.payload.you?.userId || TM.myUserId;
      TM.myTeam = data.payload.you?.team || null;
      TM.mySlot = data.payload.you?.slotKey || null;
      TM.spectator = data.payload.you?.type === "spectator";
      tmSyncFromState();
      tmRender();
      break;
    }

    case "TM_TOSS_CALLER": {
      TM.tossCaller = data.payload;
      tmRender();
      break;
    }

    case "TM_TOSS_RESULT": {
      TM.tossResult = data.payload;
      tmRender();
      break;
    }

    case "TM_DECISION": {
      const p = data.payload;
      tmToast(`${p.battingName || tmTeamName(p.battingTeam)} will bat first`, "var(--accent)");
      break;
    }

    case "TM_BALL_RESULT": {
      TM.lastBall = data.payload;
      TM.selected = [];
      TM.locked = false;
      TM.recFingers = [];
      if (data.payload.out) {
        const batting = data.payload.battingTeam;
        const teamWickets = data.payload.wickets?.[batting] ?? 1;
        const firstWicket = (TM.state?.settings?.wickets || 2) > 1 && teamWickets === 1;
        if (typeof window.playSound === "function") {
          window.playSound(firstWicket ? "firstWicket" : "wicket");
        }
      } else if (data.payload.runs === 6) {
        if (typeof window.playSound === "function") window.playSound("six");
      }
      if (TM.msgTimer) clearTimeout(TM.msgTimer);
      TM.msgTimer = setTimeout(() => {
        TM.msgTimer = null;
        TM.lastBall = null;
        if (document.getElementById("teamScreen")?.classList.contains("active")) tmRender();
      }, 2600);
      tmRender();
      break;
    }

    case "TM_LOCK_STATUS": {
      if (!TM.state?.match) break;
      const p = data.payload;
      TM.state.match.locked = TM.state.match.locked || {};
      TM.state.match.locked.batter = !!p.batterLocked;
      TM.state.match.locked.bowler = !!p.bowlerLocked;
      const bs = document.getElementById("tmLockBatterState");
      const ws = document.getElementById("tmLockBowlerState");
      if (bs) bs.textContent = p.batterLocked ? "Locked ✓" : "Waiting ⏳";
      if (ws) ws.textContent = p.bowlerLocked ? "Locked ✓" : "Waiting ⏳";
      if (p.batterLocked && TM.state.canAct?.isBatter) {
        TM.locked = true;
        const btn = document.getElementById("tmLockBtn");
        if (btn) { btn.textContent = "LOCKED ✓"; btn.disabled = true; }
      }
      if (p.bowlerLocked && TM.state.canAct?.isBowler) {
        TM.locked = true;
        const btn = document.getElementById("tmLockBtn");
        if (btn) { btn.textContent = "LOCKED ✓"; btn.disabled = true; }
      }
      break;
    }

    case "TM_TEAMMATE_HAND": {
      if (TM.mateRole === data.payload.role) {
        TM.mateFingers = data.payload.fingers || [];
        tmApplyHandLayers("tmRec", TM.mateFingers);
      }
      break;
    }

    case "TM_RECOMMENDATION": {
      const rec = data.payload;
      TM.recs = (TM.recs || []).filter(r => !(r.userId === rec.userId && r.role === rec.role));
      TM.recs.push(rec);
      if (TM.state?.canAct?.isBatter || TM.state?.canAct?.isBowler) {
        tmToast(`${rec.name}: ${(rec.fingers || []).map(f => TM_FINGER_NAMES[f] || f).join(", ")}`, "var(--accent)");
        tmRender();
      } else if (TM.recPanelOpen) {
        tmRender();
      }
      break;
    }

    case "TM_SLOT_REQUEST": {
      TM.slotRequest = data.payload;
      tmRender();
      break;
    }

    case "TM_SLOT_RESULT": {
      TM.slotRequest = null;
      tmToast(data.payload?.accepted ? "Slot swap accepted" : "Slot swap declined",
        data.payload?.accepted ? "var(--green)" : "var(--red)");
      tmRender();
      break;
    }

    case "TM_REQUEST_SENT": {
      const p = data.payload || {};
      tmToast(p.targetName ? `Request sent to ${p.targetName}` : "Request sent", "var(--accent)");
      break;
    }

    case "TM_SUB_WINDOW": {
      TM.subWindow = data.payload;
      tmRender();
      break;
    }

    case "TM_SUB_REQUEST": {
      TM.subRequests[data.payload.requestId] = data.payload;
      tmRender();
      break;
    }

    case "TM_SUB_RESULT": {
      delete TM.subRequests[data.payload?.requestId];
      tmToast(data.payload?.accepted ? "Substitution accepted" : "Substitution declined",
        data.payload?.accepted ? "var(--green)" : "var(--red)");
      tmRender();
      break;
    }

    case "TM_INNINGS_BREAK": {
      TM.break = data.payload;
      TM.subWindow = null;
      TM.selected = [];
      TM.locked = false;
      tmRender();
      break;
    }

    case "TM_INNINGS_START": {
      TM.break = null;
      TM.lastBall = null;
      tmToast(`Innings 2: ${tmTeamName(data.payload.battingTeam)} need ${data.payload.target}`, "var(--accent)");
      break;
    }

    case "TM_RESULT": {
      TM.result = data.payload;
      TM.scorecardOpen = false;
      TM.rematchRequest = null;
      TM.subWindow = null;
      TM.selected = [];
      TM.locked = false;
      if (typeof window.playSound === "function") window.playSound("wicket");
      tmRender();
      break;
    }

    case "TM_REMATCH_REQUEST": {
      TM.rematchRequest = data.payload;
      tmRender();
      break;
    }

    case "TM_REMATCH_DECLINED": {
      TM.rematchRequest = null;
      tmToast("Rematch declined", "var(--red)");
      tmRender();
      break;
    }

    case "TM_PLAYER_LEFT": {
      tmToast(`${data.payload?.name || "A player"} left`, "var(--red)");
      break;
    }

    case "TM_PLAYER_BACK": {
      tmToast(`${data.payload?.name || "A player"} reconnected`, "var(--green)");
      break;
    }

    case "TM_AUTO_SUB": {
      tmToast(`${data.payload?.name || "A teammate"} is now ${data.payload?.role === "bat" ? "batting" : "bowling"}`, "var(--amber)");
      break;
    }

    case "TM_ROOM_FULL": {
      TM.connecting = false;
      TM.joined = false;
      TM.roomFull = true;
      tmRender();
      break;
    }

    case "TM_ERROR": {
      const code = data.payload?.code;
      const msg = data.payload?.message || "Something went wrong.";
      if (code === "AUTH") {
        TM.connecting = false;
        if (typeof showAlert === "function") showAlert(msg, "🔒", () => tmLeave(true));
        else tmToast(msg, "var(--red)");
        return;
      }
      if (code === "ROOM_IN_USE" && TM.mode === "create" && TM.createTries < 3) {
        TM.createTries += 1;
        TM.code = tmGenerateCode();
        TM.connecting = true;
        tmRender();
        tmConnect("create");
        return;
      }
      TM.connecting = false;
      tmToast(msg, "var(--red)");
      if (!TM.joined) {
        tmShowSetupError(msg);
        tmRender();
      }
      break;
    }

    default:
      break;
  }
}

function tmSyncFromState() {
  const m = TM.state?.match;
  if (!m) {
    TM.selected = [];
    TM.locked = false;
    TM.recs = [];
    TM.subWindow = null;
    TM.mateRole = null;
    TM.mateFingers = [];
    return;
  }
  TM.recs = m.recommendations || [];
  TM.subWindow = m.pendingSub || null;

  const act = TM.state.canAct || {};
  if (m.phaseDetail !== "choose") {
    TM.selected = [];
    TM.locked = false;
  } else if (act.isBatter) {
    TM.selected = m.selectedBatter ? [...m.selectedBatter] : [];
    TM.locked = !!m.locked?.batter;
  } else if (act.isBowler) {
    TM.selected = m.selectedBowler ? [...m.selectedBowler] : [];
    TM.locked = !!m.locked?.bowler;
  } else {
    TM.selected = [];
    TM.locked = false;
  }

  if (act.canRecommend) {
    TM.mateRole = act.recommendRole || "bat";
    TM.mateFingers = TM.mateRole === "bat"
      ? (m.selectedBatter ? [...m.selectedBatter] : [])
      : (m.selectedBowler ? [...m.selectedBowler] : []);
  } else {
    TM.mateRole = null;
    TM.mateFingers = [];
  }

  if (m.phaseDetail !== "choose") {
    TM.recFingers = [];
    TM.recPanelOpen = false;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Rendering
   ══════════════════════════════════════════════════════════════════════ */

function tmRender() {
  const el = document.getElementById("teamScreen");
  if (!el) return;
  const scroll = el.scrollTop;
  let html;

  if (TM.disconnected && TM.joined) html = tmDisconnectedHTML();
  else if (TM.roomFull) html = tmRoomFullHTML();
  else if (TM.connecting) html = tmConnectingHTML();
  else if (!TM.joined) html = tmSetupHTML();
  else if (TM.pendingPick) html = tmPickerHTML();
  else {
    const phase = TM.state?.phase || TM.lobby?.phase || "lobby";
    if (phase === "lobby") html = tmLobbyHTML();
    else if (phase === "toss" || phase === "decision") html = tmTossHTML();
    else if (phase === "play") html = tmGameHTML();
    else if (phase === "inningsBreak") html = tmBreakHTML();
    else if (phase === "result") html = tmResultHTML();
    else html = tmConnectingHTML("Waiting for the room...");
  }

  el.innerHTML = html;
  el.scrollTop = scroll;
  tmApplyAllHands();
  tmStartSubCountdown();
}

function tmConnectingHTML(message) {
  return `<div class="tmWrap">
    <div class="tmConnecting">
      <div class="tmSpinner"></div>
      <p>${tmEsc(message || `Connecting to room ${TM.code || ""}...`)}</p>
    </div>
  </div>`;
}

function tmDisconnectedHTML() {
  return `<div class="tmWrap">
    <div class="tmCard tmResultCard">
      <h2>Connection lost</h2>
      <p class="tmMuted">The room is still running. You can reconnect to your slot.</p>
      <div class="tmBtnRow">
        <button class="btnPrimary" onclick="tmReconnect()">Reconnect</button>
        <button class="btnSecondary" onclick="tmLeave()">Leave</button>
      </div>
    </div>
  </div>`;
}

function tmRoomFullHTML() {
  return `<div class="tmWrap">
    <div class="tmCard tmResultCard">
      <div class="tmResultBadge">Room in progress</div>
      <h2>This match has already started</h2>
      <p class="tmMuted">You can watch as a spectator. Spectators cannot pick a slot or join a team.</p>
      <div class="tmBtnRow">
        <button class="btnPrimary" onclick="tmSpectateSameRoom()">👁️ Spectate</button>
        <button class="btnSecondary" onclick="tmGoHome()">Back to home</button>
      </div>
    </div>
  </div>`;
}

function tmSetupHTML() {
  return `<div class="tmWrap">
    <div class="tmTopBar">
      <h1 class="tmTopTitle">🏏 Team Mode</h1>
      <span class="tmTag">FULL 11v11</span>
      ${TM.code ? `<div class="tmRoomPill">Room <b>${tmEsc(TM.code)}</b></div>` : ""}
    </div>

    <div class="tmSetupGrid">
      <div class="tmCard">
        <h2>Create a team room</h2>
        <p class="tmMuted">Two teams, up to 11 players each. Everyone picks a slot. No captain, no pause.</p>
        <div class="tmField">
          <label>Overs per innings</label>
          <input id="tmOvers" class="tmInput" type="number" min="1" max="50" value="${TM.overs || 6}">
        </div>
        <div class="tmField">
          <label>Wickets per player</label>
          <input id="tmWickets" class="tmInput" type="number" min="1" max="10" value="${TM.wickets || 2}">
        </div>
        <div class="tmBtnRow">
          <button class="btnPrimary" onclick="tmCreateRoom()">Create Team Room</button>
        </div>
        <p class="tmHint">Each player has personal wickets. Shorter teams get the missing players' shares so both teams have the same total wickets.</p>
      </div>

      <div class="tmCard">
        <h2>Join a team room</h2>
        <p class="tmMuted">Ask the host for the 4-digit code.</p>
        <div class="tmField">
          <label>Room code</label>
          <input id="tmJoinCode" class="tmInput tmInputCode" maxlength="4" inputmode="numeric" placeholder="0000" value="">
        </div>
        <div class="tmBtnRow">
          <button class="btnPrimary" onclick="tmJoinRoom()">Join Team</button>
          <button class="btnSecondary" onclick="tmSpectate()">👁️ Spectate</button>
        </div>
        <p class="tmHint">Team matches count on your profile: +1 match and +1 win/loss for every participant.</p>
      </div>
    </div>

    <p id="tmSetupError" class="tmError"></p>
  </div>`;
}

function tmPickerHTML() {
  return `<div class="tmWrap">
    <div class="tmTopBar">
      <h1 class="tmTopTitle">Pick your slot</h1>
      <span class="tmTag">LOBBY</span>
      <div class="tmRoomPill">Room <b>${tmEsc(TM.code || "")}</b></div>
    </div>
    <p class="tmMuted">Tap an empty slot to join a team. Lowest slot acts first in the toss and the bat/bowl choice.</p>
    ${tmSlotGridHTML("pick")}
    <p class="tmHint">You can change slots before the match starts. Occupied slots need a swap request.</p>
  </div>`;
}

function tmLobbyHTML() {
  if (!TM.lobby) return tmConnectingHTML("Joining lobby...");
  const lobby = TM.lobby;
  const settings = lobby.settings || { overs: TM.overs, wickets: TM.wickets };
  const my = tmMyLobbySlot();
  const isHost = lobby.creatorId === TM.myUserId;
  const countA = (lobby.teams?.A || []).filter(s => !s.empty).length;
  const countB = (lobby.teams?.B || []).filter(s => !s.empty).length;
  const warning = (settings.overs < countA || settings.overs < countB)
    ? `<p class="tmHint" style="color:var(--amber)">Warning: some players will not bat because there are more players than overs.</p>`
    : "";

  return `<div class="tmWrap">
    <div class="tmTopBar">
      <h1 class="tmTopTitle">Team Lobby</h1>
      <span class="tmTag">${lobby.phase === "lobby" ? "WAITING" : "LIVE"}</span>
      <div class="tmRoomPill">
        Room <b>${tmEsc(lobby.roomCode || TM.code || "")}</b>
        <button class="tmCopyBtn" onclick="tmCopyCode()">Copy</button>
      </div>
    </div>

    <p class="tmMuted">
      ${settings.overs} overs per innings · ${settings.wickets} wickets per player ·
      ${countA + countB} players · ${lobby.spectatorCount || 0} watching
    </p>

    ${tmSlotGridHTML(TM.spectator ? "view" : "lobby")}
    ${warning}

    <div class="tmLobbyBar">
      ${TM.spectator
        ? `<span class="tmMuted">You are spectating. The host starts the match when everyone is ready.</span>
           <button class="btnSecondary" onclick="tmLeave()">Leave</button>`
        : `<button class="btnPrimary ${my?.ready ? "tmReadyOn" : ""}" onclick="tmToggleReady()">${my?.ready ? "✓ Ready" : "Ready"}</button>
           ${isHost
             ? `<button class="btnPrimary tmStartBtn" onclick="tmStart()" ${lobby.canStart ? "" : "disabled"}>Start Match</button>`
             : `<span class="tmMuted">Waiting for the host to start...</span>`}
           <button class="btnSecondary" onclick="tmLeave()">Leave</button>`}
    </div>

    <p class="tmHint">Tap an empty slot to move. Tap an occupied slot to send a swap request. Both players must agree.</p>
    ${tmSlotRequestModal()}
  </div>`;
}

function tmSlotGridHTML(mode) {
  const teamCol = (team) => {
    const arr = TM.lobby?.teams?.[team] || tmEmptySlots(team);
    const count = arr.filter(s => !s.empty).length;
    const rows = arr.map((s, i) => {
      const key = s.slotKey || `${team}${i + 1}`;
      if (s.empty) {
        const click = mode === "pick" || mode === "lobby" ? `onclick="tmPickSlot('${key}')"` : "";
        return `<div class="tmSlot empty" ${click}>${key} · Empty</div>`;
      }
      const mine = s.userId === TM.myUserId;
      const canAsk = (mode === "lobby") && !mine;
      const click = canAsk ? `onclick="tmRequestSwap('${key}')"` : "";
      const host = s.userId === TM.lobby?.creatorId ? `<span class="tmSlotMeta" style="color:var(--amber)">HOST</span>` : "";
      return `<div class="tmSlot ${mine ? "mine" : ""}" ${click}>
        <span class="tmSlotKey">${tmEsc(key)}</span>
        <span class="tmSlotName">${tmEsc(s.name || "Player")} ${mine ? `<span class="tmYouBadge">YOU</span>` : ""}</span>
        ${host}
        <span class="tmSlotMeta">
          <span class="tmDot ${s.connected ? "online" : "offline"}"></span>
          ${s.ready ? `<span class="tmReadyTick">✓</span>` : ""}
        </span>
      </div>`;
    }).join("");

    return `<div class="tmTeamCol team${team}">
      <div class="tmTeamHead">
        <span class="tmTeamName">${tmTeamName(team)}</span>
        <span class="tmTeamCount">${count}/11</span>
      </div>
      <div class="tmSlots">${rows}</div>
    </div>`;
  };

  return `<div class="tmSlotGrid">${teamCol("A")}${teamCol("B")}</div>`;
}

function tmEmptySlots(team) {
  return Array.from({ length: 11 }, (_, i) => ({ slotKey: `${team}${i + 1}`, empty: true }));
}

function tmTossHTML() {
  // Merge so an early TOSS_RESULT is shown even before the next state arrives.
  const t = { ...(TM.tossCaller || {}), ...(TM.state?.toss || {}), ...(TM.tossResult || {}) };
  const phase = TM.state?.phase || "toss";
  const coin = t.coin || TM.tossResult?.coin;
  const winnerTeam = t.winnerTeam || TM.tossResult?.winnerTeam;
  const callerTeam = t.callerTeam || TM.tossCaller?.callerTeam;
  const callerId = t.callerId || TM.tossCaller?.callerId;
  const chooserId = t.chooserId || TM.tossResult?.chooserId;
  const canCall = TM.state?.canAct?.canToss || (TM.tossCaller?.callerId && TM.tossCaller.callerId === TM.myUserId);
  const canChoose = !!TM.state?.canAct?.canChooseBatBowl;
  const callerName = tmNameById(callerId) || "the chosen player";
  const chooserName = tmNameById(chooserId) || "the chosen player";

  let message;
  if (phase === "toss") {
    message = `${tmTeamName(callerTeam)} is calling the toss. ${canCall ? "Make your call." : `Waiting for ${tmEsc(callerName)}...`}`;
  } else {
    message = `${tmTeamName(winnerTeam)} won the toss. ${canChoose ? "Choose to bat or bowl." : `Waiting for ${tmEsc(chooserName)}...`}`;
  }

  return `<div class="tmWrap">
    <div class="tmTopBar">
      <h1 class="tmTopTitle">Toss</h1>
      <span class="tmTag">${phase === "toss" ? "CALL" : "DECISION"}</span>
      <div class="tmRoomPill">Room <b>${tmEsc(TM.code || "")}</b></div>
    </div>

    <div class="tmTossWrap">
      <div class="tmCoin ${coin ? "flipping" : ""}">${coin ? (coin === "head" ? "HEADS" : "TAILS") : "🪙"}</div>
      <p class="tmCoinResult">${message}</p>

      ${phase === "toss" && canCall ? `<div class="tmBtnRow" style="max-width:360px;">
        <button class="btnPrimary" onclick="tmToss('head')">HEADS</button>
        <button class="btnSecondary" onclick="tmToss('tail')">TAILS</button>
      </div>` : ""}

      ${phase === "decision" && canChoose ? `<div class="tmBtnRow" style="max-width:360px;">
        <button class="btnPrimary" onclick="tmBatBowl('bat')">🏏 Bat</button>
        <button class="btnSecondary" onclick="tmBatBowl('bowl')">🎯 Bowl</button>
      </div>` : ""}

      <div class="tmTossTeams">
        ${["A", "B"].map(team => `<div class="tmTossTeam">
          <h4>${tmTeamName(team)}</h4>
          ${tmTeamPlayers(team).map(p => `<p>${tmEsc(p.name || "Player")}${p.userId === TM.myUserId ? " (you)" : ""}</p>`).join("") || `<p>No players</p>`}
        </div>`).join("")}
      </div>

      <p class="tmHint">The server randomly chooses which team calls. There is no pass option.</p>
    </div>
  </div>`;
}

function tmGameHTML() {
  const m = TM.state?.match;
  if (!m) return tmConnectingHTML("Loading match...");
  const act = TM.state.canAct || {};
  const settings = TM.state.settings || { overs: TM.overs };
  const batting = m.battingTeam;
  const bowling = m.bowlingTeam;
  const overStr = tmFormatOvers(m.balls);
  const totalOvers = settings.overs || 0;
  const target = m.target;
  const chasing = m.innings === 2;
  const runsLeft = chasing ? Math.max(0, target - m.score[batting]) : null;
  const ballsLeft = Math.max(0, totalOvers * 6 - m.balls);
  const rrr = chasing && ballsLeft > 0 ? ((runsLeft / ballsLeft) * 6).toFixed(2) : "—";

  const batter = tmPlayerById(m.activeBatterId);
  const bowler = tmPlayerById(m.activeBowlerId);
  const bs = m.stats?.[m.activeBatterId] || {};
  const bw = m.stats?.[m.activeBowlerId] || {};
  const batterName = batter?.name || "—";
  const bowlerName = bowler?.name || "—";
  const batterWkts = m.personalWickets?.[m.activeBatterId] ?? 0;
  const batterShare = m.oversShare?.[batting]?.[m.activeBatterId] ?? "—";
  const bowlerShare = m.oversShare?.[bowling]?.[m.activeBowlerId] ?? "—";

  const teamLine = (team) => {
    const hasBatted = team === batting || m.innings === 2;
    const score = hasBatted ? `${m.score[team]}/${m.wickets[team]}` : "—";
    const overs = team === batting ? overStr : (m.innings === 2 ? `${totalOvers}.0` : "—");
    return `<div class="tmScoreTeam ${team === batting ? "batting" : ""}">
      <span class="tmScoreName">${tmTeamName(team)}</span>
      <span class="tmScoreNum">${score}</span>
      <span class="tmScoreOvers">(${overs})</span>
    </div>`;
  };

  const balls = [...(m.ballHistory || [])];
  while (balls.length < 6) balls.unshift("-");

  let message;
  if (TM.lastBall) {
    const lb = TM.lastBall;
    message = lb.out
      ? `WICKET! ${tmEsc(lb.batterName || batterName)} loses a wicket`
      : `+${lb.runs} run${lb.runs === 1 ? "" : "s"} · ${tmEsc(lb.batterName || batterName)}`;
  } else if (m.phaseDetail === "choose") {
    message = `Waiting for ${tmEsc(batterName)} and ${tmEsc(bowlerName)} to lock their hands.`;
  } else if (m.phaseDetail === "subWindow") {
    message = "Substitution window — the teams are choosing who plays next.";
  } else {
    message = "Ball in play...";
  }

  const myRole = act.isBatter ? "bat" : (act.isBowler ? "bowl" : null);
  const myTurn = myRole && m.phaseDetail === "choose";
  const canRecommend = !!act.canRecommend && !TM.spectator;
  const subHTML = tmSubHTML();

  return `<div class="tmWrap">
    <div class="tmTopBar">
      <h1 class="tmTopTitle">Team Match</h1>
      <span class="tmTag">${TM.spectator ? "SPECTATING" : "LIVE"}</span>
      <div class="tmRoomPill">Room <b>${tmEsc(TM.code || "")}</b> · 👁️ ${TM.state.spectatorCount || 0}</div>
    </div>

    <div class="tmGameTop">
      <div class="tmScoreCard">
        <div class="tmInningsLine">
          <span>Innings ${m.innings}/2</span>
          <span>${tmTeamName(batting)} batting · ${overStr}/${totalOvers} ov</span>
        </div>
        ${teamLine("A")}
        ${teamLine("B")}
        <div class="tmScoreSub">
          <span>Target: <b>${chasing ? target : "—"}</b></span>
          <span>${chasing ? `Need <b>${runsLeft}</b> in <b>${ballsLeft}</b> balls` : `Balls left: <b>${ballsLeft}</b>`}</span>
          <span>RRR: <b>${rrr}</b></span>
        </div>
        <div class="tmBallStrip">
          ${balls.map(b => `<div class="tmBallBox ${b === "W" ? "wicket" : (typeof b === "number" ? "runs" : "")}">${b}</div>`).join("")}
        </div>
      </div>

      <div class="tmActiveCard">
        <div class="tmActiveRow">
          <span class="tmActiveLabel">Batting</span>
          <span class="tmActiveName">${tmEsc(batterName)}</span>
          <span class="tmActiveStats">${bs.runs || 0} (${bs.ballsFaced || 0})</span>
        </div>
        <div class="tmActiveRow">
          <span class="tmActiveLabel"></span>
          <span class="tmActiveStats">Wkts left: <b>${batterWkts}</b> · Share: <b>${batterShare}</b> ov</span>
        </div>
        <div class="tmActiveRow">
          <span class="tmActiveLabel">Bowling</span>
          <span class="tmActiveName">${tmEsc(bowlerName)}</span>
          <span class="tmActiveStats">${tmFormatOvers(bw.ballsBowled || 0)} ov</span>
        </div>
        <div class="tmActiveRow">
          <span class="tmActiveLabel"></span>
          <span class="tmActiveStats">${bw.runsConceded || 0} runs · ${bw.wicketsTaken || 0} wkts · Share: <b>${bowlerShare}</b> ov</span>
        </div>
      </div>
    </div>

    <div class="tmMessageBox ${TM.lastBall ? (TM.lastBall.out ? "wicket" : "runs") : ""}">${message}</div>

    <div id="tmLockBar" class="lockStatusBar" style="margin-top:10px;">
      <div class="lockPlayer"><span>${tmEsc(batterName)}</span><span class="lockState" id="tmLockBatterState">${m.locked?.batter ? "Locked ✓" : "Waiting ⏳"}</span></div>
      <div class="lockDivider"></div>
      <div class="lockPlayer"><span>${tmEsc(bowlerName)}</span><span class="lockState" id="tmLockBowlerState">${m.locked?.bowler ? "Locked ✓" : "Waiting ⏳"}</span></div>
    </div>

    <div class="tmControls">
      ${TM.spectator ? tmSpectatorControls() : (myTurn ? tmMyHandHTML() : tmWaitControlsHTML(myRole, batterName, bowlerName, canRecommend))}
      ${(TM.recs || []).length && (act.isBatter || act.isBowler) ? `<div class="tmRecChips">
        ${TM.recs.map(r => `<span class="tmRecChip"><b>${tmEsc(r.name)}</b>: ${tmEsc((r.fingers || []).map(f => TM_FINGER_NAMES[f] || f).join(", "))}</span>`).join("")}
      </div>` : ""}
      ${subHTML}
    </div>

    ${tmSquadsHTML()}

    ${canRecommend && !TM.recPanelOpen ? `<button class="tmRecArrow" title="Teammate view" onclick="tmToggleRecPanel()">👁️</button>` : ""}
    ${canRecommend && TM.recPanelOpen ? tmRecDrawerHTML() : ""}
    ${tmSubRequestModal()}
  </div>`;
}

function tmSpectatorControls() {
  return `<div class="tmWaitCard">
    <p>👁️ <b>Spectating</b></p>
    <p>You can see the score and the squads. Active hands and teammate recommendations stay private.</p>
  </div>`;
}

function tmWaitControlsHTML(myRole, batterName, bowlerName, canRecommend) {
  if (myRole === "bat") {
    return `<div class="tmWaitCard">
      <p>🏏 You are the active batter.</p>
      <p>Waiting for the next ball.</p>
    </div>`;
  }
  if (myRole === "bowl") {
    return `<div class="tmWaitCard">
      <p>🎯 You are the active bowler.</p>
      <p>Waiting for the next ball.</p>
    </div>`;
  }
  if (canRecommend) {
    return `<div class="tmWaitCard">
      <p>👥 <b>Teammate view available</b></p>
      <p>Open the bottom-right panel to see the active player's hand and send a finger recommendation.</p>
    </div>`;
  }
  return `<div class="tmWaitCard">
    <p>Waiting for <b>${tmEsc(batterName)}</b> and <b>${tmEsc(bowlerName)}</b>...</p>
    <p>Only their teammates can see their hands before the ball is locked.</p>
  </div>`;
}

function tmMyHandHTML() {
  return `<p class="tmHandHint">Tap fingers to open them, then lock your hand.</p>
    ${tmHandHTML("tm", true)}
    <p class="tmSelectedLine">Selected: <b id="tmSelectedDisplay">${tmSelectedText()}</b></p>
    <button class="btnLock tmLockBtn" id="tmLockBtn" onclick="tmLockHand()" ${TM.locked ? "disabled" : ""}>${TM.locked ? "LOCKED ✓" : "🔒 LOCK HAND"}</button>`;
}

function tmSelectedText(fingers) {
  const list = fingers || TM.selected || [];
  return list.length ? list.map(f => TM_FINGER_NAMES[f] || f).join(", ") : "None";
}

function tmHandHTML(prefix, interactive) {
  const hit = (finger, style) => interactive
    ? `<div class="hitbox" onclick="tmToggleFinger('${finger}')" style="${style}"></div>`
    : "";
  return `<div class="handContainer tmHandContainer">
    <div class="handRig" id="${prefix}Rig">
      <img class="handLayer base" src="hands/base-hand.png" alt="">
      <img class="handLayer" id="${prefix}-layer-pinky"  src="hands/pinky.png"  alt="">
      <img class="handLayer" id="${prefix}-layer-ring"   src="hands/ring.png"   alt="">
      <img class="handLayer" id="${prefix}-layer-middle" src="hands/middle.png" alt="">
      <img class="handLayer" id="${prefix}-layer-index"  src="hands/index.png"  alt="">
      <img class="handLayer" id="${prefix}-layer-thumb-dark"  src="hands/thumb_1.png" alt="">
      <img class="handLayer" id="${prefix}-layer-thumb-light" src="hands/thumb_2.png" alt="">
      ${hit("thumb",  "left:19.70%;top:24.01%;width:17.05%;height:50.00%;")}
      ${hit("index",  "left:38.25%;top:0.33%;width:11.09%;height:54.64%;")}
      ${hit("middle", "left:50.00%;top:0.50%;width:9.93%;height:54.64%;")}
      ${hit("ring",   "left:60.76%;top:0.33%;width:7.95%;height:54.64%;")}
      ${hit("pinky",  "left:69.21%;top:13.25%;width:8.61%;height:40.73%;")}
    </div>
  </div>`;
}

function tmApplyHandLayers(prefix, fingers) {
  const on = (finger) => (fingers || []).includes(finger);
  for (const f of ["index", "middle", "ring", "pinky"]) {
    const el = document.getElementById(`${prefix}-layer-${f}`);
    if (el) el.classList.toggle("open", on(f));
  }
  const dark = document.getElementById(`${prefix}-layer-thumb-dark`);
  const light = document.getElementById(`${prefix}-layer-thumb-light`);
  if (dark) dark.classList.toggle("open", on("thumb"));
  if (light) light.classList.toggle("open", on("thumb"));
}

function tmApplyAllHands() {
  tmApplyHandLayers("tm", TM.selected);
  tmApplyHandLayers("tmRec", TM.mateFingers);
  tmApplyHandLayers("tmMate", TM.mateFingers);
}

function tmSquadsHTML() {
  if (!TM.squadsOpen) {
    return `<button class="btnSecondary fullWidth tmSquadsBtn" onclick="tmToggleSquads()">👥 Show squads</button>`;
  }
  const m = TM.state?.match;
  const squad = (team) => {
    const players = tmTeamPlayers(team);
    return `<div class="tmSquad">
      <h4>${tmTeamName(team)}</h4>
      ${players.map(p => {
        const wk = m?.personalWickets?.[p.userId];
        const share = m?.oversShare?.[team]?.[p.userId];
        const active = m && (p.userId === m.activeBatterId || p.userId === m.activeBowlerId);
        return `<div class="tmSquadRow">
          <span class="tmSquadStat">${tmEsc(p.slotKey || "")}</span>
          <span class="tmSquadName ${active ? "tmSquadActive" : ""}">${tmEsc(p.name || "Player")}${active ? (p.userId === m.activeBatterId ? " 🏏" : " 🎯") : ""}</span>
          ${m ? `<span class="tmSquadStat">${m.battingTeam === team ? (wk ?? 0) : "—"} wkts · ${share ?? 0} ov</span>` : ""}
          <span class="tmDot ${p.connected ? "online" : "offline"}"></span>
        </div>`;
      }).join("") || `<p class="tmMuted">No players yet.</p>`}
    </div>`;
  };
  return `<div class="tmSquads">${squad("A")}${squad("B")}</div>
    <button class="btnSecondary fullWidth tmSquadsBtn" onclick="tmToggleSquads()">Hide squads</button>`;
}

function tmRecDrawerHTML() {
  const m = TM.state?.match;
  const act = TM.state?.canAct || {};
  const role = act.recommendRole || TM.mateRole;
  if (!m || !role) return "";
  const activeId = role === "bat" ? m.activeBatterId : m.activeBowlerId;
  const activeName = tmNameById(activeId);
  const recs = (TM.recs || []).filter(r => r.role === role);

  return `<div class="tmRecDrawer">
    <div class="tmDrawerHead">
      <h3>👥 Teammate view</h3>
      <button class="tmCloseX" onclick="tmToggleRecPanel()">✕</button>
    </div>
    <p class="tmMuted">${tmEsc(activeName)} is choosing. Only teammates can see this hand.</p>
    <div class="tmDrawerHand">${tmHandHTML("tmRec", false)}</div>
    <p class="tmSelectedLine" style="text-align:center;">Showing: <b>${tmSelectedText(TM.mateFingers)}</b></p>

    <div class="tmRecList">
      ${recs.length ? recs.map(r => `<div class="tmRecLine">
        <span><b>${tmEsc(r.name)}</b></span>
        <span class="tmFingerBadge">${tmEsc((r.fingers || []).map(f => TM_FINGER_NAMES[f] || f).join(", "))}</span>
      </div>`).join("") : `<p class="tmMuted">No recommendations yet.</p>`}
    </div>

    <p class="tmHint">Pick the fingers you suggest, then send. The active player is not forced to accept.</p>
    <div class="tmRecFingerGrid">
      ${["thumb", "index", "middle", "ring", "pinky"].map(f => `<button class="tmRecFingerBtn ${TM.recFingers.includes(f) ? "on" : ""}" onclick="tmRecFinger('${f}')">${TM_FINGER_NAMES[f]}</button>`).join("")}
    </div>
    <p class="tmSelectedLine">Your suggestion: <b id="tmRecSelectedDisplay">${tmSelectedText(TM.recFingers)}</b></p>
    <div class="tmBtnRow">
      <button class="btnPrimary" onclick="tmSendRecommendation()">🔒 Lock recommendation</button>
    </div>
  </div>`;
}

function tmSubHTML() {
  const m = TM.state?.match;
  const sub = TM.subWindow || m?.pendingSub;
  if (!m || !sub) return "";
  const myTeam = TM.state?.you?.team;
  const role = myTeam === m.battingTeam ? "bat" : (myTeam === m.bowlingTeam ? "bowl" : null);
  if (!role) {
    return `<div class="tmSubCard"><h3>Substitution</h3><p class="tmMuted">The teams are choosing who plays next.</p></div>`;
  }
  const resolved = sub.resolved?.[role];
  const currentId = role === "bat" ? m.activeBatterId : m.activeBowlerId;
  const currentName = tmNameById(currentId) || "—";
  const options = (role === "bat" ? sub.batterOptions : sub.bowlerOptions) || [];
  const verb = role === "bat" ? "bat" : "bowl";
  const currentAlive = (m.personalWickets?.[currentId] ?? 0) > 0;
  const isCurrent = TM.myUserId === currentId;
  const meOption = options.some(o => o.userId === TM.myUserId);

  if (resolved) {
    if (role === "bowl" && sub.reason === "wicket") {
      return `<div class="tmSubCard">
        <h3>Wicket</h3>
        <p class="tmMuted">The batting team is choosing the next batter. Your bowler stays for the next ball.</p>
      </div>`;
    }
    return `<div class="tmSubCard">
      <h3>${role === "bat" ? "Batting change" : "Bowling change"}</h3>
      <p class="tmSubResolved">✓ Decided</p>
    </div>`;
  }

  const otherOptions = options.filter(o => o.userId !== TM.myUserId);
  let buttons = "";
  if (isCurrent) {
    // At an over break the current bowler appears in the option list; the
    // "keep current" button already covers staying, so don't ask yourself.
    buttons = otherOptions
      .map(o => `<button class="tmSubOptionBtn" onclick="tmSubRequest(${o.userId},'${role}')">Ask ${tmEsc(o.name)} to ${verb}${o.shareLeft === 0 ? " <span class=\"tmMuted\">(0 ov left)</span>" : ""}</button>`)
      .join("");
  } else if (meOption) {
    buttons = `<button class="tmSubOptionBtn" onclick="tmSubRequest(${TM.myUserId},'${role}')">Ask to ${verb}</button>`;
  }

  const curShareBalls = (m.oversShare?.[role === "bat" ? m.battingTeam : m.bowlingTeam]?.[currentId] || 0) * 6;
  const curSpent = role === "bat"
    ? (m.inningsBallsFaced?.[currentId] || 0) >= curShareBalls
    : (m.inningsBallsBowled?.[currentId] || 0) >= curShareBalls;
  const keepLabel = role === "bat"
    ? (currentAlive ? "Keep current batter" : "Next batter")
    : (curSpent ? "Next bowler" : "Keep current bowler");

  return `<div class="tmSubCard">
    <h3>${sub.reason === "wicket" ? "Wicket — next player" : "Over break — change players"}</h3>
    <p class="tmMuted">Current ${verb === "bat" ? "batter" : "bowler"}: <b>${tmEsc(currentName)}</b>${role === "bat" && !currentAlive ? " (out)" : ""}</p>
    ${otherOptions.length || meOption ? `<div class="tmSubOptions">${buttons || `<span class="tmMuted">Waiting for ${tmEsc(currentName)} to choose...</span>`}</div>` : `<p class="tmMuted">No other teammate is available right now.</p>`}
    <p class="tmHint">The default share order is a starting point — the remaining over can be negotiated with any teammate.</p>
    <div class="tmBtnRow">
      <button class="btnSecondary" onclick="tmSubContinue('${role}', false)">${keepLabel}</button>
      ${otherOptions.length ? `<button class="btnSecondary" onclick="tmSubContinue('${role}', true)">Next in order</button>` : ""}
    </div>
    <p class="tmSubCountdown" id="tmSubCountdown">15s</p>
  </div>`;
}

function tmSubRequestModal() {
  const req = Object.values(TM.subRequests).find(r => r.approverId === TM.myUserId);
  if (!req) return "";
  const verb = req.role === "bat" ? "bat" : "bowl";
  return `<div class="tmOverlay">
    <div class="tmModal">
      <h3>${req.role === "bat" ? "Batting change" : "Bowling change"}</h3>
      <p class="tmMuted"><b>${tmEsc(req.fromName || "A teammate")}</b> wants <b>${tmEsc(req.targetName || "a teammate")}</b> to ${verb} next.</p>
      <div class="tmBtnRow">
        <button class="btnPrimary" onclick="tmSubResponse('${req.requestId}', true)">Accept</button>
        <button class="btnSecondary" onclick="tmSubResponse('${req.requestId}', false)">Decline</button>
      </div>
    </div>
  </div>`;
}

function tmSlotRequestModal() {
  const r = TM.slotRequest;
  if (!r) return "";
  return `<div class="tmOverlay">
    <div class="tmModal">
      <h3>Slot swap request</h3>
      <p class="tmMuted"><b>${tmEsc(r.fromName || "A player")}</b> (${tmEsc(r.fromSlot || "")}) wants your slot <b>${tmEsc(r.targetSlot || "")}</b>.</p>
      <div class="tmBtnRow">
        <button class="btnPrimary" onclick="tmRespondSwap('${r.requestId}', true)">Accept</button>
        <button class="btnSecondary" onclick="tmRespondSwap('${r.requestId}', false)">Decline</button>
      </div>
    </div>
  </div>`;
}

function tmBreakHTML() {
  const b = TM.break || {};
  const m = TM.state?.match || {};
  const target = b.target ?? m.target ?? "—";
  const battingTeam = b.battingTeam || m.battingTeam;
  const score = b.innings1Score ?? m.score?.[battingTeam] ?? 0;
  const wickets = b.innings1Wickets ?? m.wickets?.[battingTeam] ?? 0;

  return `<div class="tmWrap">
    <div class="tmTopBar">
      <h1 class="tmTopTitle">Innings Break</h1>
      <span class="tmTag">⚡ BREAK</span>
      <div class="tmRoomPill">Room <b>${tmEsc(TM.code || "")}</b></div>
    </div>
    <div class="tmCard tmResultCard">
      <div class="tmResultBadge">1st innings</div>
      <h2 class="tmResultTitle">${tmTeamName(battingTeam)} ${score}/${wickets}</h2>
      <p class="tmResultSub">Target: <b>${target}</b> · ${tmTeamName(battingTeam === "A" ? "B" : "A")} need ${target} to win</p>
      <div class="tmBtnRow" style="max-width:360px;margin:0 auto;">
        <button class="btnSecondary" onclick="tmToggleSquads()">👥 Squads</button>
      </div>
      <p class="tmHint">The second innings starts automatically in a few seconds.</p>
    </div>
    ${TM.squadsOpen ? tmSquadsHTML() : ""}
  </div>`;
}

function tmResultHTML() {
  const r = TM.result || TM.state?.match?.result;
  if (!r) return tmConnectingHTML("Waiting for the result...");
  const winner = r.winnerTeam;
  const title = winner === "draw" ? "Match drawn" : `${tmTeamName(winner)} won`;
  const myTeam = TM.myTeam;
  const canRematch = !TM.spectator;

  return `<div class="tmWrap">
    <div class="tmTopBar">
      <h1 class="tmTopTitle">Result</h1>
      <span class="tmTag">FINAL</span>
      <div class="tmRoomPill">Room <b>${tmEsc(TM.code || "")}</b></div>
    </div>

    <div class="tmCard tmResultCard">
      <div class="tmResultBadge">${winner === "draw" ? "DRAW" : "WINNER"}</div>
      <h2 class="tmResultTitle">${title}</h2>
      <p class="tmResultSub">${tmEsc(r.resultText || "")}</p>
      <div class="tmResultScores">
        <div class="tmResultScore"><span>${tmTeamName("A")}</span><b>${r.scoreA}/${r.wicketsA}</b></div>
        <div class="tmResultScore"><span>${tmTeamName("B")}</span><b>${r.scoreB}/${r.wicketsB}</b></div>
      </div>
      ${myTeam ? `<p class="tmMuted">Your team: <b>${tmTeamName(myTeam)}</b> · ${winner === "draw" ? "Draw" : (winner === myTeam ? "Win" : "Loss")}</p>` : ""}

      <div class="tmBtnRow" style="max-width:520px;margin:14px auto 0;">
        <button class="btnPrimary" onclick="tmOpenScorecard()">📋 Full scorecard</button>
        ${canRematch ? `<button class="btnSecondary" onclick="tmRematch()">🔁 Rematch</button>` : ""}
        <button class="btnSecondary" onclick="tmLeave()">Leave</button>
      </div>

      ${TM.rematchRequest && !TM.spectator ? `<div class="tmMessageBox" style="margin-top:12px;">
        <b>${tmEsc(TM.rematchRequest.name || "A player")}</b> (${tmTeamName(TM.rematchRequest.team)}) wants a rematch.
        ${TM.rematchRequest.team !== myTeam
          ? `<div class="tmBtnRow" style="max-width:360px;margin:8px auto 0;"><button class="btnPrimary" onclick="tmRematchResponse(true)">Accept</button><button class="btnSecondary" onclick="tmRematchResponse(false)">Decline</button></div>`
          : `<span class="tmMuted">Waiting for the other team...</span>`}
      </div>` : ""}
    </div>

    ${TM.scorecardOpen ? tmScorecardModal(r.scorecard) : ""}
  </div>`;
}

function tmScorecardModal(scorecard) {
  return `<div class="tmOverlay">
    <div class="tmModal tmModalWide">
      <div class="tmDrawerHead">
        <h3>📋 Scorecard</h3>
        <button class="tmCloseX" onclick="tmCloseScorecard()">✕</button>
      </div>
      ${tmScorecardHTML(scorecard)}
      <div class="tmBtnRow">
        <button class="btnSecondary" onclick="tmCloseScorecard()">Close</button>
      </div>
    </div>
  </div>`;
}

function tmScorecardHTML(scorecard) {
  if (!scorecard || !scorecard.length) return `<p class="tmMuted">No scorecard data.</p>`;
  const byTeam = { A: [], B: [] };
  for (const p of scorecard) (byTeam[p.team] ||= []).push(p);
  for (const t of ["A", "B"]) {
    byTeam[t].sort((a, b) => tmSlotOrder(a.slotKey) - tmSlotOrder(b.slotKey));
  }

  const statusLabel = (s) => s === "out" ? "out" : s === "not_out" ? "not out" : s === "retired" ? "retired" : "—";
  const statusClass = (s) => s === "out" ? "tmStatusOut" : s === "not_out" ? "tmStatusNotOut" : s === "retired" ? "tmStatusRetired" : "tmStatusDnb";

  return ["A", "B"].map(team => `<div class="tmScorecardTeamTitle">${tmTeamName(team)}</div>
    <table class="tmScorecardTable">
      <thead><tr><th>Batter</th><th>R</th><th>B</th><th>Wkts</th><th>Status</th></tr></thead>
      <tbody>
        ${byTeam[team].map(p => `<tr>
          <td>${tmEsc(p.name)}</td>
          <td>${p.runs}</td>
          <td>${p.ballsFaced}</td>
          <td>${p.wicketsLost}</td>
          <td class="${statusClass(p.outStatus)}">${statusLabel(p.outStatus)}</td>
        </tr>`).join("") || `<tr><td colspan="5" class="tmMuted">No batters.</td></tr>`}
      </tbody>
    </table>
    <table class="tmScorecardTable">
      <thead><tr><th>Bowler</th><th>O</th><th>R</th><th>W</th></tr></thead>
      <tbody>
        ${byTeam[team].filter(p => p.ballsBowled > 0).map(p => `<tr>
          <td>${tmEsc(p.name)}</td>
          <td>${tmFormatOvers(p.ballsBowled)}</td>
          <td>${p.runsConceded}</td>
          <td>${p.wicketsTaken}</td>
        </tr>`).join("") || `<tr><td colspan="4" class="tmMuted">No bowling.</td></tr>`}
      </tbody>
    </table>`).join("");
}

function tmSlotOrder(key) {
  const m = /^([AB])(\d+)$/.exec(key || "");
  return m ? parseInt(m[2], 10) : 999;
}

/* ══════════════════════════════════════════════════════════════════════
   Actions
   ══════════════════════════════════════════════════════════════════════ */

function tmSend(data) {
  if (!TM.ws || TM.ws.readyState !== WebSocket.OPEN) {
    tmToast("Connection is not open.", "var(--red)");
    return false;
  }
  TM.ws.send(JSON.stringify(data));
  return true;
}

function tmPickSlot(slotKey) {
  if (TM.spectator) return;
  tmSend({ type: "TM_PICK_SLOT", payload: { slot: slotKey } });
}

function tmRequestSwap(slotKey) {
  if (TM.spectator || TM.pendingPick) return;
  tmSend({ type: "TM_SWAP_REQUEST", payload: { targetSlot: slotKey } });
}

function tmRespondSwap(requestId, accept) {
  tmSend({ type: "TM_SWAP_RESPONSE", payload: { requestId, accept } });
  TM.slotRequest = null;
  tmRender();
}

function tmToggleReady() {
  const my = tmMyLobbySlot();
  tmSend({ type: "TM_READY", payload: { ready: !my?.ready } });
}

function tmStart() {
  tmSend({ type: "TM_START" });
}

function tmToss(choice) {
  tmSend({ type: "TM_TOSS_CALL", payload: { choice } });
}

function tmBatBowl(choice) {
  tmSend({ type: "TM_BAT_BOWL", payload: { choice } });
}

function tmToggleFinger(finger) {
  if (TM.locked) return;
  const act = TM.state?.canAct || {};
  if (!act.isBatter && !act.isBowler) return;
  if (!["thumb", "index", "middle", "ring", "pinky"].includes(finger)) return;
  if (TM.selected.includes(finger)) TM.selected = TM.selected.filter(f => f !== finger);
  else TM.selected.push(finger);

  tmApplyHandLayers("tm", TM.selected);
  const label = document.getElementById("tmSelectedDisplay");
  if (label) label.textContent = tmSelectedText();
  tmSend({ type: "TM_HAND_SELECT", payload: { fingers: TM.selected } });
}

function tmLockHand() {
  if (TM.locked) return;
  if (!TM.selected.length) {
    tmToast("Select at least one finger first.", "var(--amber)");
    return;
  }
  if (!tmSend({ type: "TM_HAND_LOCK" })) return;
  TM.locked = true;
  const btn = document.getElementById("tmLockBtn");
  if (btn) { btn.textContent = "LOCKED ✓"; btn.disabled = true; }
}

function tmToggleRecPanel() {
  if (!TM.state?.canAct?.canRecommend) return;
  TM.recPanelOpen = !TM.recPanelOpen;
  if (TM.recPanelOpen) TM.recFingers = [];
  tmRender();
}

function tmRecFinger(finger) {
  if (TM.recFingers.includes(finger)) TM.recFingers = TM.recFingers.filter(f => f !== finger);
  else TM.recFingers.push(finger);
  const label = document.getElementById("tmRecSelectedDisplay");
  if (label) label.textContent = tmSelectedText(TM.recFingers);
  document.querySelectorAll(".tmRecFingerBtn").forEach(btn => {
    const f = btn.textContent.trim().toLowerCase();
    btn.classList.toggle("on", TM.recFingers.includes(f));
  });
}

function tmSendRecommendation() {
  const role = TM.state?.canAct?.recommendRole;
  if (!role) return;
  if (!TM.recFingers.length) {
    tmToast("Pick at least one finger to recommend.", "var(--amber)");
    return;
  }
  if (!tmSend({ type: "TM_RECOMMEND", payload: { role, fingers: TM.recFingers } })) return;
  tmToast("Recommendation sent", "var(--accent)");
  TM.recFingers = [];
  tmRender();
}

function tmSubRequest(targetUserId, role) {
  tmSend({ type: "TM_SUB_REQUEST", payload: { targetUserId, role } });
}

function tmSubResponse(requestId, accept) {
  tmSend({ type: "TM_SUB_RESPONSE", payload: { requestId, accept } });
  delete TM.subRequests[requestId];
  tmRender();
}

function tmSubContinue(role, next) {
  tmSend({ type: "TM_SUB_CONTINUE", payload: { role, next: !!next } });
}

function tmToggleSquads() {
  TM.squadsOpen = !TM.squadsOpen;
  tmRender();
}

function tmOpenScorecard() {
  TM.scorecardOpen = true;
  tmRender();
}

function tmCloseScorecard() {
  TM.scorecardOpen = false;
  tmRender();
}

function tmRematch() {
  tmSend({ type: "TM_REMATCH_REQUEST" });
}

function tmRematchResponse(accept) {
  tmSend({ type: "TM_REMATCH_RESPONSE", payload: { accept } });
  if (!accept) TM.rematchRequest = null;
  tmRender();
}

function tmCopyCode() {
  const code = TM.code || TM.lobby?.roomCode;
  if (!code) return;
  const done = () => tmToast(`Room code copied: ${code}`, "var(--green)");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(() => prompt("Room code", code));
  } else {
    prompt("Room code", code);
  }
}

function tmStartSubCountdown() {
  if (TM.countdownTimer) { clearInterval(TM.countdownTimer); TM.countdownTimer = null; }
  const el = document.getElementById("tmSubCountdown");
  if (!el || !TM.subWindow?.expiresAt) return;
  const tick = () => {
    const left = Math.max(0, Math.ceil((TM.subWindow.expiresAt - Date.now()) / 1000));
    const node = document.getElementById("tmSubCountdown");
    if (node) node.textContent = `${left}s`;
    if (left <= 0) {
      if (TM.countdownTimer) { clearInterval(TM.countdownTimer); TM.countdownTimer = null; }
    }
  };
  tick();
  TM.countdownTimer = setInterval(tick, 250);
}

/* ══════════════════════════════════════════════════════════════════════
   Small helpers
   ══════════════════════════════════════════════════════════════════════ */

function tmTeamName(team) {
  return TM.lobby?.teamNames?.[team]
      || TM.state?.teamNames?.[team]
      || (team === "A" ? "Team A" : team === "B" ? "Team B" : "—");
}

function tmTeamPlayers(team) {
  const st = TM.state?.teams?.[team];
  if (Array.isArray(st) && st.length) return st;
  const lob = TM.lobby?.teams?.[team];
  if (Array.isArray(lob)) return lob.filter(s => !s.empty);
  return [];
}

function tmPlayerById(userId) {
  if (userId == null) return null;
  for (const team of ["A", "B"]) {
    const found = tmTeamPlayers(team).find(p => p.userId === userId);
    if (found) return found;
  }
  return null;
}

function tmNameById(userId) {
  const p = tmPlayerById(userId);
  return p?.name || null;
}

function tmMyLobbySlot() {
  if (!TM.mySlot) return null;
  for (const team of ["A", "B"]) {
    const arr = TM.lobby?.teams?.[team] || [];
    const found = arr.find(s => s.slotKey === TM.mySlot);
    if (found && !found.empty) return found;
  }
  return null;
}

function tmFormatOvers(balls) {
  const b = Number(balls) || 0;
  return `${Math.floor(b / 6)}.${b % 6}`;
}
