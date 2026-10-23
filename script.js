/* script.js — Crickverse clean rebuild */

// ══════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════
const AUTH_URL = "https://test.mahin-aistudio.workers.dev"; // ← change this after deploy
const WS_URL   = "wss://test.mahin-aistudio.workers.dev";   // ← same worker URL

// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let socket  = null;
let mySlot  = null;
let roomCode = "";
let generatedCode = "";
let isHost      = false;
let isSpectator = false;
let gameMode    = "limited";
let matchMode   = "limited";
let matchOvers  = 0;
let matchWickets = 0;

// Auth
let authToken       = localStorage.getItem("cv_token")        || null;
let authUsername    = localStorage.getItem("cv_username")     || null;
let authDisplayName = localStorage.getItem("cv_display_name") || null;
let authFullName    = localStorage.getItem("cv_full_name")    || null;
let authIsAdmin     = localStorage.getItem("cv_is_admin") === "true";
let playerName = authDisplayName || "";
let authBan = null; // Fix #10: tracks ban state

// Escape text inserted into profile/home match rows.
function cvEsc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Render a solo or team match row for the home/profile recent lists.
function renderRecentMatchRow(m, backTab, compact, viewUsername) {
  const date = new Date(m.playedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  if (m.type === "team") {
    const members = (m.members || []).map(p => {
      const status = (p.ballsFaced || 0) > 0
        ? (p.outStatus === "out" ? " out" : p.outStatus === "retired" ? " retired" : " not out")
        : "";
      return `<span class="teamMatchMember team${cvEsc(p.team)}">${cvEsc(p.name)}${p.username === viewUsername ? " (you)" : ""} · ${p.runs}${status}</span>`;
    }).join("");
    return `<div class="matchRow teamMatchRow">
      <div style="min-width:0;">
        <span style="font-weight:600;color:var(--text);">${cvEsc(m.myTeamName)} vs ${cvEsc(m.oppTeamName)}</span>
        <span style="color:var(--text-muted);font-size:11px;margin-left:6px;">${date}</span>
        ${compact ? "" : `<div class="teamMatchMembers">${members}</div>`}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
        <span style="color:var(--text-muted);font-size:12px;">${m.myScore}/${m.myWickets} vs ${m.oppScore}/${m.oppWickets}</span>
        <span class="matchRowBadge ${m.result}">${String(m.result || "").toUpperCase()}</span>
      </div>
    </div>`;
  }

  const oppLabel = m.opponent || "Deleted User";
  const oppAttr = m.opponent
    ? `onclick="openProfile(${cvEsc(JSON.stringify(m.opponent))}, ${cvEsc(JSON.stringify(backTab || "homeScreen"))})" style="cursor:pointer;"`
    : `onclick="showToast('This user is no longer available','var(--text-muted)')" style="cursor:pointer;"`;
  return `<div class="matchRow">
    <div>
      <span style="font-weight:600;color:var(--text);" ${oppAttr}>${cvEsc(oppLabel)}</span>
      <span style="color:var(--text-muted);font-size:11px;margin-left:6px;">${date}</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="color:var(--text-muted);font-size:12px;">${m.myScore} vs ${m.oppScore}</span>
      <span class="matchRowBadge ${m.result}">${String(m.result || "").toUpperCase()}</span>
    </div>
  </div>`;
}

// Match
let currentInnings     = 1;
// Permanent display name store — set once on ROOM_JOINED/SYNC, never cleared
window._displayNames   = { A: null, B: null };

// Returns the permanent display name for slot, falling back to DOM if needed
function _nameFor(slot) {
  return window._displayNames[slot] || (slot === "A"
    ? document.getElementById("teamA").textContent
    : document.getElementById("teamB").textContent) || "Player " + slot;
}
let currentBattingName = "";
let currentBowlingName = "";
let isTossing          = false;
let selectedFingers    = [];
let lastBalls          = [];
let syncedBallHistory  = [];
let localBallCount     = 0;
let previewCountdownTimer = null;
let breakCountdownTimer   = null;
let currentNavTab = "homeScreen";

// Leave popup state
let leavePopupFromInMatch = false;
let declareFromMenu       = false;

// spectatorSyncBuffer: holds live messages that arrive while a spectator is waiting for SYNC_STATE
// (covers both late-join AND watch-rematch scenarios — same path, same buffer)
let spectatorSyncBuffer = [];

// Sounds
const sounds = {
  wicket:        new Audio("sounds/wicket.mp3"),
  firstWicket:   new Audio("sounds/first-wicket.mp3"),
  six:           new Audio("sounds/six.m4a"),
};
Object.values(sounds).forEach(a => { a.preload = "auto"; a.load(); });

// Track wickets per batting team per innings for first-wicket sound logic
let _wicketCountA = 0;
let _wicketCountB = 0;

// Settings
const DEFAULT_KEYBINDS = {
  // Game controls — fingers
  thumb:"Digit1", index:"Digit2", middle:"Digit3", ring:"Digit4", pinky:"Digit5",
  lock:"Space",
  // Toss
  toss_heads:"KeyW", toss_tails:"KeyS", toss_pass:"KeyE",
  // Bat / Bowl
  bat:"KeyA", bowl:"KeyD",
  // UI
  confirm:"Enter", back_cancel:"Escape",
  theme:"Backquote",
  declare:"KeyQ",
  settings:"F1",
  // Spectate join (hold Shift then Enter on home screen code input)
  spectate:"ShiftLeft",
  // Nav cycle (single key cycles through tabs: Home→Friends→LB→Profile→Settings→Home)
  nav_cycle:"Home",
  // Profile actions (always active on own profile)
  profile_delete:"Delete",
  profile_logout:"Backspace",
  // Settings actions
  settings_reset:"End",
};
// Keys shown in the keybind list — ONLY these are shown/editable
const KEYBIND_LABELS = {
  thumb:"👍 Thumb",
  index:"☝️ Index",
  middle:"🖕 Middle",
  ring:"💍 Ring",
  pinky:"🤙 Pinky",
  lock:"🔒 Lock Hand",
  toss_heads:"🪙 Toss — Heads",
  toss_tails:"🪙 Toss — Tails",
  toss_pass:"🪙 Toss — Pass",
  bat:"🏏 Choose Bat",
  bowl:"🎳 Choose Bowl",
  confirm:"✅ Confirm / Enter",
  back_cancel:"⬅️ Back / Cancel",
  theme:"🌙 Toggle Theme",
  spectate:"👁️ Spectate (Hold+Enter)",
  declare:"🏳️ Declare",
  settings:"⚙️ Settings",
  nav_cycle:"🔄 Cycle Tabs",
  profile_delete:"🗑️ Delete Account",
  profile_logout:"↩️ Logout",
  settings_reset:"🔁 Reset Keybinds",
};
const RISKY_KEYBINDS = new Set(["confirm","back_cancel","spectate"]);
const RISKY_REASONS  = {
  confirm:     "This key confirms actions everywhere. Rebinding may break navigation.",
  back_cancel: "This key closes popups and goes back. Rebinding may lock screens.",
  spectate:    "Held with Enter to spectate-join. Should be a modifier key (Shift/Alt/Ctrl).",
};

let keybinds        = { ...DEFAULT_KEYBINDS };
let keyboardEnabled = true;   // default ON; overridden by loadSettings()
let mouseEnabled    = true;
let sfxEnabled      = true;
let sfxVolume       = 80;
let bgmEnabled      = true;
let bgmVolume       = 50;

// ══════════════════════════════════════════════
// SETTINGS PERSISTENCE
// ══════════════════════════════════════════════
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("cv_settings") || "{}");
    if (s.keybinds) {
      // Merge saved keybinds over defaults — only keep known keys
      const merged = { ...DEFAULT_KEYBINDS };
      for (const k of Object.keys(DEFAULT_KEYBINDS)) {
        if (s.keybinds[k]) merged[k] = s.keybinds[k];
      }
      keybinds = merged;
    }
    if (s.keyboardEnabled !== undefined) keyboardEnabled = s.keyboardEnabled;
    if (s.mouseEnabled    !== undefined) mouseEnabled = s.mouseEnabled;
    if (s.sfxEnabled      !== undefined) sfxEnabled   = s.sfxEnabled;
    if (s.sfxVolume       !== undefined) sfxVolume    = s.sfxVolume;
    if (s.bgmEnabled      !== undefined) bgmEnabled   = s.bgmEnabled;
    if (s.bgmVolume       !== undefined) bgmVolume    = s.bgmVolume;
  } catch(_) {}
}
function saveSettings() {
  localStorage.setItem("cv_settings", JSON.stringify({ keybinds, keyboardEnabled, mouseEnabled, sfxEnabled, sfxVolume, bgmEnabled, bgmVolume }));
}

// ══════════════════════════════════════════════
// BGM
// ══════════════════════════════════════════════
const bgmAudio = document.getElementById("bgmAudio");
bgmAudio.src    = "sounds/bgm.mp3";
bgmAudio.loop   = true;
bgmAudio.volume = bgmVolume / 100;

function initBGM() {
  if (bgmEnabled) bgmAudio.play().catch(() => {});
}
function toggleBGM() {
  bgmEnabled = !bgmEnabled;
  document.getElementById("bgmToggleTrack").classList.toggle("on", bgmEnabled);
  if (bgmEnabled) bgmAudio.play().catch(() => {}); else bgmAudio.pause();
  saveSettings();
}
function setBGMVolume(val) {
  bgmVolume = parseInt(val);
  document.getElementById("bgmVolumeVal").textContent = bgmVolume;
  bgmAudio.volume = bgmEnabled ? bgmVolume / 100 : 0;
  saveSettings();
}

window.playSound = function(name) {
  if (!sfxEnabled) return;
  if (sounds[name]) {
    sounds[name].volume      = sfxVolume / 100;
    sounds[name].currentTime = 0;
    sounds[name].play().catch(() => {});
  }
};

// ══════════════════════════════════════════════
// BAN HELPERS (client-side, local timezone)
// ══════════════════════════════════════════════
function formatBanDate(isoString) {
  // Format ban date in the USER's local browser timezone
  const d = new Date(isoString);
  const timeStr = d.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true })
    .replace(":00 ", " ").replace(" am", " a.m").replace(" pm", " p.m");
  const dateStr = d.toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });
  return `${timeStr}, ${dateStr}`;
}

function getBanMessage(ban, suffix = "") {
  if (!ban) return "";
  // ban.active is set from login/me responses; ban from room WS only has {permanent, until}
  // So accept either .active=true OR presence of .permanent field
  const isBan = ban.active || ban.permanent !== undefined;
  if (!isBan) return "";
  if (ban.permanent) return "Your account is permanently banned." + (suffix ? " " + suffix : "");
  if (!ban.until) return "Your account is banned." + (suffix ? " " + suffix : "");
  return `You are banned until ${formatBanDate(ban.until)}.` + (suffix ? " " + suffix : "");
}

// ══════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════
async function checkAutoLogin() {
  if (!authToken) { showScreen("authScreen"); return; }
  try {
    const res = await fetch(AUTH_URL + "/auth/me", {
      headers: { "Authorization": "Bearer " + authToken },
    });
    if (res.ok) {
      const d = await res.json();
      authUsername    = d.username;
      authIsAdmin     = d.is_admin;
      authDisplayName = d.display_name || d.username;
      authFullName    = d.full_name    || "";
      authBan         = d.ban || null;
      _saveAuthLocals();
      playerName = authDisplayName;
      enterApp();
    } else { clearAuth(); showScreen("authScreen"); }
  } catch { clearAuth(); showScreen("authScreen"); }
}

function clearAuth() {
  authToken = authUsername = authDisplayName = authFullName = null;
  authIsAdmin = false;
  ["cv_token","cv_username","cv_display_name","cv_full_name","cv_is_admin"]
    .forEach(k => localStorage.removeItem(k));
}

function _saveAuthLocals() {
  localStorage.setItem("cv_token",        authToken);
  localStorage.setItem("cv_username",     authUsername);
  localStorage.setItem("cv_display_name", authDisplayName);
  localStorage.setItem("cv_full_name",    authFullName);
  localStorage.setItem("cv_is_admin",     authIsAdmin);
}

async function authFetch(url, options = {}) {
  if (!options.headers) options.headers = {};
  options.headers["Authorization"] = "Bearer " + authToken;
  const res = await fetch(url, options);
  if (res.status === 401) {
    clearAuth();
    showAlert("Session expired. Please log in again.", "🔒");
    setTimeout(() => location.reload(), 1500);
    throw new Error("Session expired");
  }
  return res;
}

function switchAuthTab(tab) {
  document.getElementById("authTabLogin").classList.toggle("active",    tab === "login");
  document.getElementById("authTabRegister").classList.toggle("active", tab === "register");
  document.getElementById("authLoginForm").style.display    = tab === "login"    ? "flex" : "none";
  document.getElementById("authRegisterForm").style.display = tab === "register" ? "flex" : "none";
}

async function doLogin() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl    = document.getElementById("loginError");
  errEl.textContent = "";
  if (!username || !password) { errEl.textContent = "Fill in all fields."; return; }
  try {
    const res  = await fetch(AUTH_URL + "/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Login failed."; return; }
    authToken       = data.token;
    authUsername    = data.username;
    authIsAdmin     = data.is_admin;
    authDisplayName = data.display_name || data.username;
    authFullName    = data.full_name    || "";
    authBan         = data.ban || null;
    _saveAuthLocals();
    playerName = authDisplayName;
    enterApp();
  } catch { errEl.textContent = "Network error. Try again."; }
}

async function doRegister() {
  const fullName    = document.getElementById("regFullName").value.trim();
  const displayName = document.getElementById("regDisplayName").value.trim();
  const username    = document.getElementById("regUsername").value.trim();
  const password    = document.getElementById("regPassword").value;
  const otp         = document.getElementById("regOTP").value.trim().toUpperCase();
  const errEl       = document.getElementById("registerError");
  errEl.textContent = "";
  if (!fullName || !displayName || !username || !password || !otp) {
    errEl.textContent = "Fill in all fields including OTP."; return;
  }
  try {
    const res  = await fetch(AUTH_URL + "/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, displayName, username, password, otp }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Registration failed."; return; }
    authToken       = data.token;
    authUsername    = data.username;
    authIsAdmin     = false;
    authDisplayName = displayName;
    authFullName    = fullName;
    _saveAuthLocals();
    playerName = authDisplayName;
    enterApp();
  } catch { errEl.textContent = "Network error. Try again."; }
}

// ══════════════════════════════════════════════
// INPUT ENTER-KEY CHAINING
// ══════════════════════════════════════════════
function initInputChaining() {
  const chains = [
    { inputs: ["loginUsername","loginPassword"],                                          action: doLogin },
    { inputs: ["regFullName","regDisplayName","regUsername","regPassword","regOTP"],       action: doRegister },
    { inputs: ["cpCurrent","cpNew","cpConfirm"],                                           action: doChangePassword },
    { inputs: ["oversInput","wicketsInput"],                                               action: createRoom },
    { inputs: ["addFriendInput"],                                                          action: sendFriendRequest },
    { inputs: ["deletePassword"],                                                          action: doDeleteAccount },
  ];
  chains.forEach(({ inputs, action }) => {
    inputs.forEach((id, i) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        // Try to move to next unfilled visible field first
        for (let j = i + 1; j < inputs.length; j++) {
          const nextEl = document.getElementById(inputs[j]);
          if (nextEl && nextEl.offsetParent !== null) {
            nextEl.focus();
            return;
          }
        }
        // All remaining fields done — fire action
        action();
      });
    });
  });

  // ── joinRoomCodeInput: GATED by keyboardEnabled ─────────────────────────
  // Plain Enter = join as player, Shift+Enter = spectate
  // Both require keyboard to be ON (unlike other form chains above)
  const joinEl = document.getElementById("joinRoomCodeInput");
  if (joinEl) {
    joinEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (!keyboardEnabled) return;          // gated — keyboard OFF blocks this
      e.preventDefault();
      const code = joinEl.value.trim();
      if (!code) return;
      const specKey  = keybinds.spectate;
      const specHeld = (specKey === "ShiftLeft"    && e.shiftKey)
                    || (specKey === "ShiftRight"   && e.shiftKey)
                    || (specKey === "AltLeft"      && e.altKey)
                    || (specKey === "AltRight"     && e.altKey)
                    || (specKey === "ControlLeft"  && e.ctrlKey)
                    || (specKey === "ControlRight" && e.ctrlKey);
      if (specHeld) spectateRoom(); else joinRoom();
    });
  }

  // ── Esc on changePassword inputs → close popup (keyboard-independent) ────
  ["cpCurrent","cpNew","cpConfirm"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closePopup("changePasswordPopup"); }
    });
  });

  // ── Esc on deletePassword input → close popup (keyboard-independent) ─────
  const delPwEl = document.getElementById("deletePassword");
  if (delPwEl) {
    delPwEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closePopup("deleteAccountPopup"); }
    });
  }
}

async function doLogout() {
  if (authToken) {
    await fetch(AUTH_URL + "/auth/logout", {
      method: "POST", headers: { "Authorization": "Bearer " + authToken },
    }).catch(() => {});
  }
  clearAuth();
  if (socket) { socket.close(); socket = null; }
  location.reload();
}

function enterApp() {
  showBottomNav(true);
  switchTab("homeScreen", "navHome");
  loadHomeData();
  startPresenceHeartbeat();
  if (authIsAdmin) {
    const sec = document.getElementById("adminHomeSection");
    if (sec) sec.style.display = "block";
    document.getElementById("homeScreen").classList.add("admin-scroll");
  } else {
    document.getElementById("homeScreen").classList.remove("admin-scroll");
  }
  if (authBan && authBan.active) {
    setTimeout(() => showToast("⚠️ " + getBanMessage(authBan), "var(--amber)", "#0f172a", 3000), 500);
  }
}

// ── Session validity poll ────────────────────────────────────────────────────
// Admin ban kills the session in DB. This poll hits /auth/me every 30s.
// authFetch auto-catches 401 (session deleted) → "Session expired" → reload.
// Result: banned player is force-logged out within 30s of the ban being applied,
// or instantly on their next nav tap that triggers an authFetch call.
let _sessionPollTimer = null;

function startPresenceHeartbeat() {
  if (_sessionPollTimer) return;
  _sessionPollTimer = setInterval(async () => {
    if (!authToken) return;
    try {
      await authFetch(AUTH_URL + "/auth/me");
      // 401 inside authFetch already handles logout + reload
    } catch (_) {}
  }, 30_000);
}

function stopPresenceHeartbeat() {
  if (_sessionPollTimer) { clearInterval(_sessionPollTimer); _sessionPollTimer = null; }
}

function updatePresenceStatus() {}

// ══════════════════════════════════════════════
// SCREEN MANAGEMENT
// ══════════════════════════════════════════════
const TAB_SCREENS = ["homeScreen","friendsScreen","leaderboardScreen","profileScreen","settingsScreen"];

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");

  const isGame     = id === "gameScreen";
  const isTabScreen = TAB_SCREENS.includes(id);
  const isAuth     = id === "authScreen";

  showBottomNav(isTabScreen);
  document.getElementById("globalBackBtn").style.display =
    (isTabScreen || isAuth) ? "none" : "block";
  if (!isGame) document.getElementById("gameDeclareBtn").style.display = "none";
  if (isSpectator) document.getElementById("spectatorBadge").classList.add("visible");
  document.getElementById("settingsBtn").style.display = isGame ? "flex" : "none";
  document.getElementById("keybindSection").style.display = isGame ? "none" : "block";
}

function showBottomNav(v) {
  document.getElementById("bottomNav").style.display = v ? "flex" : "none";
}

function switchTab(screenId, navId) {
  if (!TAB_SCREENS.includes(screenId)) return;
  document.querySelectorAll(".navBtn").forEach(b => b.classList.remove("active"));
  document.getElementById(navId).classList.add("active");
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
  currentNavTab = screenId;
  showBottomNav(true);
  document.getElementById("globalBackBtn").style.display = "none";
  document.getElementById("gameDeclareBtn").style.display = "none";
  document.getElementById("settingsBtn").style.display = "none";
  // Always ensure keybindSection is visible when on settings tab (hidden during game)
  document.getElementById("keybindSection").style.display = "block";
  if (screenId === "settingsScreen") loadSettingsUI();
}

// ══════════════════════════════════════════════
// BACK / LEAVE LOGIC
// ══════════════════════════════════════════════
function handleBack() {
  const active = document.querySelector(".screen.active");
  if (!active) return;
  const id = active.id;

  if (id === "teamScreen") {
    if (typeof tmLeave === "function") tmLeave();
    return;
  }

  // Tab screens block back EXCEPT profileScreen which has its own back logic below
  const noBackScreens = ["homeScreen","friendsScreen","leaderboardScreen","settingsScreen","authScreen"];
  if (noBackScreens.includes(id)) return;

  if (id === "profileScreen") {
    const ret = window._profileReturnTab || "homeScreen";
    const navMap = { homeScreen:"navHome", friendsScreen:"navFriends", leaderboardScreen:"navLeaderboard", profileScreen:"navProfile", settingsScreen:"navSettings" };
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(ret).classList.add("active");
    document.querySelectorAll(".navBtn").forEach(b => b.classList.remove("active"));
    document.getElementById(navMap[ret] || "navHome").classList.add("active");
    document.getElementById("globalBackBtn").style.display = "none";
    showBottomNav(true);
    currentNavTab = ret;
    if (ret === "friendsScreen")     loadFriends();
    if (ret === "leaderboardScreen") loadLeaderboard();
    window._viewingProfile   = null;
    window._profileReturnTab = null;
    return;
  }

  if (id === "roomSetupScreen") {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById("homeScreen").classList.add("active");
    document.querySelectorAll(".navBtn").forEach(b => b.classList.remove("active"));
    document.getElementById("navHome").classList.add("active");
    currentNavTab = "homeScreen";
    showBottomNav(true);
    document.getElementById("globalBackBtn").style.display = "none";
    return;
  }

  if (id === "resultScreen") { exitMatch(); return; }

  if (id === "lobbyScreen") {
    if (isSpectator) { document.getElementById("spectatorLeavePopup").style.display = "flex"; }
    else { document.getElementById("leavePopupMsg").innerText = "Leave the lobby?"; document.getElementById("leavePopup").style.display = "flex"; }
    return;
  }

  if (["tossScreen","decisionScreen","matchPreviewScreen","inningsBreakScreen"].includes(id)) {
    if (isSpectator) { document.getElementById("spectatorLeavePopup").style.display = "flex"; }
    else { document.getElementById("leavePopupMsg").innerText = "Leave the match? Opponent will be notified."; document.getElementById("leavePopup").style.display = "flex"; }
    return;
  }

  if (id === "gameScreen") {
    if (isSpectator) { document.getElementById("spectatorLeavePopup").style.display = "flex"; return; }
    const isBatter2 = currentInnings === 2
      && ((mySlot === "A" && currentBattingName === document.getElementById("teamA").innerText)
       || (mySlot === "B" && currentBattingName === document.getElementById("teamB").innerText));
    if (isBatter2) { document.getElementById("inMatchLeavePopup").style.display = "flex"; }
    else { document.getElementById("leavePopupMsg").innerText = "Leave the match? Opponent will be notified."; document.getElementById("leavePopup").style.display = "flex"; }
    return;
  }
}

function closePopup(id) {
  document.getElementById(id).style.display = "none";
}

function confirmLeave() {
  stopPresenceHeartbeat();
  document.querySelectorAll(".popupOverlay").forEach(el => {
    el.style.display = "none";
    if (!el.id) el.remove();
  });
  if (socket) {
    socket.send(JSON.stringify({ type: "PLAYER_LEAVE", player: mySlot }));
    socket.close(); socket = null;
  }
  isSpectator = false; mySlot = null;
  document.getElementById("spectatorBadge").classList.remove("visible");
  showBottomNav(true);
  switchTab("homeScreen", "navHome");
  loadHomeData();
}

function confirmLeaveWithConfirm() {
  closePopup("inMatchLeavePopup");
  leavePopupFromInMatch = true;
  document.getElementById("leavePopupMsg").innerText = "Leave the match? Opponent will be notified.";
  document.getElementById("leavePopup").style.display = "flex";
}

function cancelLeavePopup() {
  closePopup("leavePopup");
  if (leavePopupFromInMatch) {
    leavePopupFromInMatch = false;
    document.getElementById("inMatchLeavePopup").style.display = "flex";
  }
}

function cancelDeclare() {
  closePopup("declarePopup");
  if (declareFromMenu) {
    declareFromMenu = false;
    document.getElementById("inMatchLeavePopup").style.display = "flex";
  }
}

function showDeclareFromMenu() {
  closePopup("inMatchLeavePopup");
  declareFromMenu = true;
  document.getElementById("declarePopup").style.display = "flex";
}

function exitMatch() {
  if (isSpectator) { document.getElementById("spectatorLeavePopup").style.display = "flex"; }
  else { document.getElementById("leavePopupMsg").innerText = "Leave and go back to menu?"; document.getElementById("leavePopup").style.display = "flex"; }
}

// ══════════════════════════════════════════════
// HOME DATA
// ══════════════════════════════════════════════
async function loadHomeData() {
  document.getElementById("joinRoomCodeInput").value = "";
  const name      = authDisplayName || authUsername || "—";
  const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=6366f1&color=fff&size=128&bold=true`;
  const homeAvatar = document.getElementById("homeAvatar");
  if (homeAvatar) homeAvatar.src = avatarUrl;
  document.getElementById("homeDisplayName").textContent = name;
  document.getElementById("homeUsername").textContent    = "@" + (authUsername || "—");

  try {
    const res  = await fetch(AUTH_URL + "/auth/profile/" + encodeURIComponent(authUsername));
    const data = await res.json();
    if (!res.ok) return;
    const s = data.stats;
    document.getElementById("hStatPlayed").textContent  = s.played;
    document.getElementById("hStatWins").textContent    = s.wins;
    document.getElementById("hStatLosses").textContent  = s.losses;
    document.getElementById("hStatWinRate").textContent = s.winRate + "%";
    if (data.rank) {
      const rt = document.getElementById("homeRankTag");
      rt.textContent      = data.rank.tag;
      rt.style.background = data.rank.color + "22";
      rt.style.color      = data.rank.color;
      rt.style.border     = "1px solid " + data.rank.color + "55";
    }
    if (s.played > 0) {
      const sec  = document.getElementById("analyticsSection");
      const grid = document.getElementById("analyticsGrid");
      if (sec && grid) {
        sec.style.display = "flex";
        grid.innerHTML = `
          <div class="analyticsItem"><p class="analyticsLabel">Favourite Mode</p><p class="analyticsValue">${s.favouriteMode}</p></div>
          <div class="analyticsItem"><p class="analyticsLabel">Best Score</p><p class="analyticsValue">${s.highestScore}</p></div>
          <div class="analyticsItem"><p class="analyticsLabel">Win Rate</p><p class="analyticsValue">${s.winRate}%</p></div>
          <div class="analyticsItem"><p class="analyticsLabel">Draws</p><p class="analyticsValue">${s.draws}</p></div>`;
      }
    }
    const homeRecent = document.getElementById("homeRecentMatches");
    if (homeRecent) {
      if (!data.recentMatches || data.recentMatches.length === 0) {
        homeRecent.innerHTML = '<p class="profileLoading">No matches yet. Create a room to play!</p>';
      } else {
        homeRecent.innerHTML = data.recentMatches.slice(0, 3)
          .map(m => renderRecentMatchRow(m, "homeScreen", true, authUsername))
          .join("");
      }
    }
  } catch(_) {}
}



// ══════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════
function openOwnProfile() { openProfile(authUsername); }

async function openProfile(username, returnTab = null) {
  if (!username) return;
  const dn       = authDisplayName || username;
  const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(dn)}&background=6366f1&color=fff&size=128&bold=true`;
  document.getElementById("profileAvatarImg").src = avatarUrl;

  if (username !== authUsername) {
    // Capture where to go back to BEFORE switching screens.
    // Priority: explicit returnTab param → current tab screen → existing _profileReturnTab → home
    const fromTab = TAB_SCREENS.includes(currentNavTab);
    window._profileReturnTab = returnTab
      || (fromTab ? currentNavTab : null)
      || window._profileReturnTab
      || "homeScreen";

    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById("profileScreen").classList.add("active");
    document.getElementById("globalBackBtn").style.display = "block";
    showBottomNav(true);
    currentNavTab = "profileScreen";
  } else {
    showScreen("profileScreen");
    document.querySelectorAll(".navBtn").forEach(b => b.classList.remove("active"));
    document.getElementById("navProfile").classList.add("active");
    currentNavTab = "profileScreen";
    window._profileReturnTab = null;
    window._profileReturnUsername = null;
  }

  window._viewingProfile = username;
  const isOwn = username === authUsername;
  document.getElementById("logoutFromProfileBtn").style.display  = isOwn ? "block" : "none";
  document.getElementById("changePasswordBtn").style.display     = isOwn ? "block" : "none";
  document.getElementById("deleteAccountBtn").style.display      = isOwn ? "block" : "none";
  document.getElementById("addFriendProfileBtn").style.display   = "none";

  document.getElementById("profileUsername").textContent    = "Loading...";
  document.getElementById("profileDisplayName").textContent = "";
  document.getElementById("profileSince").textContent       = "";
  document.getElementById("profileRankTag").textContent     = "";
  document.getElementById("recentMatchesList").innerHTML = '<p class="profileLoading">Loading...</p>';
  ["statPlayed","statWins","statLosses","statDraws","statHighScore","statFavMode"].forEach(id => {
    document.getElementById(id).textContent = "—";
  });
  document.getElementById("statWinRate").textContent = "—%";

  try {
    const [profRes, friendRes] = await Promise.all([
      fetch(AUTH_URL + "/auth/profile/" + encodeURIComponent(username)),
      !isOwn ? authFetch(AUTH_URL + "/auth/friends") : Promise.resolve(null),
    ]);
    const data = await profRes.json();
    if (!profRes.ok) { document.getElementById("profileUsername").textContent = "Not found."; return; }

    const pdn = data.displayName || username;
    document.getElementById("profileAvatarImg").src =
      `https://ui-avatars.com/api/?name=${encodeURIComponent(pdn)}&background=6366f1&color=fff&size=128&bold=true`;

    const mainName = data.fullName || data.displayName || data.username;
    document.getElementById("profileUsername").innerHTML = isOwn
      ? mainName + ' <span style="font-size:11px;background:var(--accent);color:white;padding:2px 8px;border-radius:99px;font-family:var(--font-body);font-weight:600;vertical-align:middle;">You</span>'
      : mainName;
    document.getElementById("profileDisplayName").textContent = "@" + data.username;
    document.getElementById("profileSince").textContent =
      "Member since " + new Date(data.memberSince).toLocaleDateString("en-GB",{ month:"short",year:"numeric" });

    if (data.rank) {
      const rt = document.getElementById("profileRankTag");
      rt.textContent      = data.rank.tag;
      rt.style.background = data.rank.color + "22";
      rt.style.color      = data.rank.color;
      rt.style.border     = "1px solid " + data.rank.color + "55";
    }

    const s = data.stats;
    document.getElementById("statPlayed").textContent    = s.played;
    document.getElementById("statWins").textContent      = s.wins;
    document.getElementById("statLosses").textContent    = s.losses;
    document.getElementById("statDraws").textContent     = s.draws;
    document.getElementById("statWinRate").textContent   = s.winRate + "%";
    document.getElementById("statHighScore").textContent = s.highestScore;
    document.getElementById("statFavMode").textContent   = s.played > 0 ? s.favouriteMode : "—";

    const rml = document.getElementById("recentMatchesList");
    if (!data.recentMatches || data.recentMatches.length === 0) {
      rml.innerHTML = '<p class="profileLoading">No matches played yet.</p>';
    } else {
      const backTab = window._profileReturnTab || "homeScreen";
      rml.innerHTML = data.recentMatches
        .map(m => renderRecentMatchRow(m, backTab, false, data.username))
        .join("");
    }

    if (!isOwn && friendRes) {
      const fdata = await friendRes.json();
      const btn   = document.getElementById("addFriendProfileBtn");
      const isFriend  = (fdata.friends || []).some(f => f.username === username);
      const isSent    = (fdata.sent    || []).some(f => f.username === username);
      const isPending = (fdata.pending || []).some(f => f.username === username);
      // Remove any stale decline button from a previous profile load
      document.getElementById("declineFriendProfileBtn")?.remove();
      if (isFriend) {
        btn.textContent = "✅ Already Friends"; btn.className = "btnSecondary fullWidth profileActionBtn";
        btn.style.display = "block"; btn.disabled = true;
      } else if (isSent) {
        btn.textContent = "⏳ Request Sent"; btn.className = "btnSecondary fullWidth profileActionBtn";
        btn.style.display = "block"; btn.disabled = true;
      } else if (isPending) {
        btn.textContent = "✅ Accept Request"; btn.className = "btnPrimary fullWidth profileActionBtn";
        btn.style.display = "block"; btn.disabled = false;
        btn.onclick = () => respondFriendRequest(username, "accept");
        const declineBtn = document.createElement("button");
        declineBtn.id = "declineFriendProfileBtn";
        declineBtn.className = "btnSecondary fullWidth profileActionBtn";
        declineBtn.style.cssText = "display:block;color:var(--red);border-color:var(--red);";
        declineBtn.textContent = "❌ Decline Request";
        declineBtn.onclick = () => respondFriendRequest(username, "decline");
        btn.insertAdjacentElement("afterend", declineBtn);
      } else {
        btn.textContent = "👥 Add Friend"; btn.className = "btnPrimary fullWidth profileActionBtn";
        btn.style.display = "block"; btn.disabled = false; btn.onclick = addFriendFromProfile;
      }
    }
  } catch { document.getElementById("profileDisplayName").textContent = "Network error."; }
}

async function addFriendFromProfile() {
  const username = window._viewingProfile;
  if (!username) return;
  const btn = document.getElementById("addFriendProfileBtn");
  btn.disabled = true; btn.textContent = "Sending...";
  try {
    const res  = await authFetch(AUTH_URL + "/auth/friends/request", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ username }),
    });
    const data = await res.json();
    btn.textContent = res.ok ? "✅ Request Sent!" : (data.error || "Error");
    if (!res.ok) btn.disabled = false;
  } catch { btn.textContent = "Network error"; btn.disabled = false; }
}

// ══════════════════════════════════════════════
// FRIENDS
// ══════════════════════════════════════════════
async function sendFriendRequest() {
  const username = document.getElementById("addFriendInput").value.trim();
  const msgEl    = document.getElementById("addFriendMsg");
  msgEl.style.color = "var(--text-muted)";
  msgEl.textContent = "";
  if (!username) return;
  try {
    const res  = await authFetch(AUTH_URL + "/auth/friends/request", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ username }),
    });
    const data = await res.json();
    if (!res.ok) { msgEl.style.color = "var(--red)"; msgEl.textContent = data.error || "Error."; }
    else { msgEl.style.color = "var(--green)"; msgEl.textContent = "✅ " + data.message; document.getElementById("addFriendInput").value = ""; loadFriends(); }
  } catch { msgEl.style.color = "var(--red)"; msgEl.textContent = "Network error."; }
}

async function respondFriendRequest(fromUsername, action) {
  try {
    await authFetch(AUTH_URL + "/auth/friends/respond", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ fromUsername, action }),
    });
    if (window._viewingProfile && window._viewingProfile === fromUsername) {
      openProfile(fromUsername, window._profileReturnTab || "homeScreen");
    } else {
      loadFriends();
    }
  } catch(_) {}
}

async function removeFriend(username) {
  try {
    await authFetch(AUTH_URL + "/auth/friends/remove", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ username }),
    });
    loadFriends();
  } catch(_) {}
}

async function loadFriends() {
  document.getElementById("friendsList").innerHTML = '<p class="profileLoading">Loading...</p>';
  try {
    const res  = await authFetch(AUTH_URL + "/auth/friends");
    if (!res.ok) return;
    const data = await res.json();

    // Fix #9: presence removed

    const pendingSection = document.getElementById("pendingSection");
    const pendingList    = document.getElementById("pendingList");
    if (data.pending && data.pending.length > 0) {
      pendingSection.style.display = "block";
      pendingList.innerHTML = data.pending.map(p => `
        <div class="friendRow">
          <div class="friendAvatar">${(p.display_name||p.username).charAt(0).toUpperCase()}</div>
          <div style="flex:1;min-width:0;">
            <div class="friendName" onclick="openProfile('${p.username}', 'friendsScreen')">${p.display_name||p.username}</div>
            <div style="font-size:11px;color:var(--text-muted);">@${p.username}</div>
          </div>
          <div class="friendActions">
            <button class="btnPrimary"   onclick="respondFriendRequest('${p.username}','accept')">✅</button>
            <button class="btnSecondary" onclick="respondFriendRequest('${p.username}','decline')">✕</button>
          </div>
        </div>`).join("");
    } else { pendingSection.style.display = "none"; }

    const sentSection = document.getElementById("sentSection");
    const sentList    = document.getElementById("sentList");
    if (data.sent && data.sent.length > 0) {
      sentSection.style.display = "block";
      sentList.innerHTML = data.sent.map(s => `
        <div class="friendRow">
          <div class="friendAvatar">${(s.display_name||s.username).charAt(0).toUpperCase()}</div>
          <div style="flex:1;min-width:0;">
            <div class="friendName" onclick="openProfile('${s.username}', 'friendsScreen')" style="font-weight:600;font-size:13px;">${s.display_name||s.username}</div>
            <div style="font-size:11px;color:var(--text-muted);">@${s.username}</div>
          </div>
          <button class="btnSecondary" style="font-size:11px;padding:4px 10px;color:var(--red);border-color:var(--red);"
            onclick="removeFriend('${s.username}')">Cancel</button>
        </div>`).join("");
    } else { sentSection.style.display = "none"; }

    const fl = document.getElementById("friendsList");
    if (!data.friends || data.friends.length === 0) {
      fl.innerHTML = '<p class="profileLoading">No friends yet.</p>';
    } else {
      fl.innerHTML = data.friends.map(f => `
        <div class="friendRow">
          <div class="friendAvatar">${(f.display_name||f.username).charAt(0).toUpperCase()}</div>
          <div style="flex:1;min-width:0;">
            <div class="friendName" onclick="openProfile('${f.username}', 'friendsScreen')">${f.display_name||f.username}</div>
            <div style="font-size:11px;color:var(--text-muted);">@${f.username}</div>
          </div>
          <div class="friendActions">
            <button class="btnSecondary" onclick="removeFriend('${f.username}')">Remove</button>
          </div>
        </div>`).join("");
    }
  } catch { document.getElementById("friendsList").innerHTML = '<p class="profileLoading">Network error.</p>'; }
}

function joinFriendLobby(code) {
  document.getElementById("joinRoomCodeInput").value = code;
  switchTab("homeScreen","navHome");
  setTimeout(() => joinRoom(), 100);
}

// ══════════════════════════════════════════════
// LEADERBOARD
// ══════════════════════════════════════════════
async function loadLeaderboard() {
  document.getElementById("leaderboardList").innerHTML = '<p class="profileLoading">Loading...</p>';
  try {
    const res  = await fetch(AUTH_URL + "/auth/leaderboard");
    const data = await res.json();
    if (!res.ok || !data.leaderboard) return;
    if (data.leaderboard.length === 0) {
      document.getElementById("leaderboardList").innerHTML = '<p class="profileLoading">Not enough matches yet.<br>Play 3+ to appear here!</p>';
      return;
    }
    const rE = i => i===0?"🥇":i===1?"🥈":i===2?"🥉":(i+1);
    const rC = i => i===0?"gold":i===1?"silver":i===2?"bronze":"";
    document.getElementById("leaderboardList").innerHTML = data.leaderboard.map((p,i) => `
      <div class="lbRow">
        <span class="lbRank ${rC(i)}">${rE(i)}</span>
        <span class="lbName" onclick="openProfile('${p.username}', 'leaderboardScreen')">${p.display_name||p.username}</span>
        <div class="lbStats"><strong>${p.win_rate}%</strong><br>${p.wins}W ${p.losses}L ${p.draws}D · ${p.played} played</div>
      </div>`).join("");
  } catch { document.getElementById("leaderboardList").innerHTML = '<p class="profileLoading">Network error.</p>'; }
}

// ══════════════════════════════════════════════
// CHANGE PASSWORD / DELETE ACCOUNT
// ══════════════════════════════════════════════
function openChangePassword() {
  ["cpCurrent","cpNew","cpConfirm"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("cpError").textContent   = "";
  document.getElementById("cpSuccess").textContent = "";
  document.getElementById("changePasswordPopup").style.display = "flex";
}

async function doChangePassword() {
  const current = document.getElementById("cpCurrent").value;
  const newPw   = document.getElementById("cpNew").value;
  const confirm = document.getElementById("cpConfirm").value;
  const errEl   = document.getElementById("cpError");
  const okEl    = document.getElementById("cpSuccess");
  errEl.textContent = ""; okEl.textContent = "";
  if (!current || !newPw || !confirm) { errEl.textContent = "Fill in all fields."; return; }
  if (newPw !== confirm) { errEl.textContent = "Passwords don't match."; return; }
  if (newPw.length < 6)  { errEl.textContent = "Password too short."; return; }
  try {
    const res  = await authFetch(AUTH_URL + "/auth/change-password", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ currentPassword:current, newPassword:newPw }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Failed."; return; }
    okEl.textContent = "✅ Password changed!";
    setTimeout(() => closePopup("changePasswordPopup"), 1500);
  } catch { errEl.textContent = "Network error."; }
}

function openDeleteAccount() {
  document.getElementById("deletePassword").value  = "";
  document.getElementById("deleteError").textContent = "";
  document.getElementById("deleteAccountPopup").style.display = "flex";
}

async function doDeleteAccount() {
  const password = document.getElementById("deletePassword").value;
  const errEl    = document.getElementById("deleteError");
  errEl.textContent = "";
  if (!password) { errEl.textContent = "Enter your password."; return; }
  try {
    const res  = await fetch(AUTH_URL + "/auth/delete-account", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+authToken},
      body:JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Error."; return; }
    clearAuth();
    if (socket) { socket.close(); socket = null; }
    location.reload();
  } catch { errEl.textContent = "Network error."; }
}

// ══════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════
function openAdminPanel() {
  switchAdminTab("otp");
  document.getElementById("otpResult").style.display = "none";
  document.getElementById("adminPanel").style.display = "flex";
}

function switchAdminTab(tab) {
  document.getElementById("adminTabOtp").classList.toggle("active",   tab==="otp");
  document.getElementById("adminTabUsers").classList.toggle("active", tab==="users");
  document.getElementById("adminTabGame").classList.toggle("active",  tab==="game");
  document.getElementById("adminPaneOtp").style.display   = tab==="otp"   ? "flex" : "none";
  document.getElementById("adminPaneUsers").style.display = tab==="users" ? "flex" : "none";
  document.getElementById("adminPaneGame").style.display  = tab==="game"  ? "flex" : "none";
  if (tab === "users") loadAdminUsers();
  if (tab === "game")  loadAdminSettings();
}

function renderTossStrategyStatus(enabled) {
  const el = document.getElementById("tossStrategyStatus");
  if (!el) return;
  el.textContent = enabled
    ? "ON — first match in each new room uses the hidden test toss. Rematches stay random."
    : "OFF — first match in each new room uses the old random toss.";
  el.style.color = enabled ? "var(--green)" : "var(--text-muted)";
}

async function loadAdminSettings() {
  const track  = document.getElementById("tossStrategyToggle");
  const status = document.getElementById("tossStrategyStatus");
  if (!track || !status) return;
  status.textContent = "Loading...";
  status.style.color = "var(--text-muted)";
  try {
    const res  = await authFetch(AUTH_URL + "/auth/admin/settings");
    const data = await res.json();
    if (!res.ok) { status.textContent = data.error || "Error."; return; }
    track.classList.toggle("on", !!data.tossStrategyEnabled);
    renderTossStrategyStatus(!!data.tossStrategyEnabled);
  } catch {
    status.textContent = "Network error.";
  }
}

async function toggleTossStrategy() {
  const track  = document.getElementById("tossStrategyToggle");
  const status = document.getElementById("tossStrategyStatus");
  if (!track || !status || track.dataset.saving === "1") return;

  const next = !track.classList.contains("on");
  track.classList.toggle("on", next);
  renderTossStrategyStatus(next);

  track.dataset.saving = "1";
  track.style.pointerEvents = "none";
  status.textContent = "Saving...";
  try {
    const res  = await authFetch(AUTH_URL + "/auth/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tossStrategyEnabled: next }),
    });
    const data = await res.json();
    if (!res.ok) {
      track.classList.toggle("on", !next);
      renderTossStrategyStatus(!next);
      status.textContent = data.error || "Error.";
      return;
    }
    track.classList.toggle("on", !!data.tossStrategyEnabled);
    renderTossStrategyStatus(!!data.tossStrategyEnabled);
  } catch {
    track.classList.toggle("on", !next);
    renderTossStrategyStatus(!next);
    status.textContent = "Network error.";
  } finally {
    delete track.dataset.saving;
    track.style.pointerEvents = "";
  }
}

async function generateOTPs() {
  const count    = parseInt(document.getElementById("otpCount").value) || 1;
  const resultEl = document.getElementById("otpResult");
  resultEl.style.display = "block";
  resultEl.textContent   = "Generating...";
  try {
    const res  = await authFetch(AUTH_URL + "/auth/otp/generate", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ count }),
    });
    const data = await res.json();
    if (!res.ok) { resultEl.textContent = data.error || "Error."; return; }
    resultEl.innerHTML = data.codes.map(c => `<div style="padding:4px 0;border-bottom:1px solid var(--border);">${c}</div>`).join("")
      + `<div style="color:var(--text-muted);font-size:11px;margin-top:6px;">Expires in 24h</div>`;
  } catch { resultEl.textContent = "Network error."; }
}

async function loadAdminUsers() {
  document.getElementById("adminUserList").innerHTML = '<p class="profileLoading">Loading...</p>';
  try {
    const res  = await authFetch(AUTH_URL + "/auth/admin/users");
    const data = await res.json();
    if (!res.ok) { document.getElementById("adminUserList").innerHTML = '<p class="profileLoading">Error.</p>'; return; }
    document.getElementById("adminUserList").innerHTML = data.users.map(u => {
      const now     = new Date();
      const banDate = u.banned_until ? new Date(u.banned_until + "Z") : null;
      const isBanned = banDate && banDate > now;
      const isPerm   = isBanned && banDate.getFullYear() >= 9999;
      let banLabel = "";
      if (isBanned) {
        if (isPerm) {
          banLabel = "Banned (Permanent)";
        } else {
          // Fix #3: Just time+date, no "Banned until" prefix (red colour is enough)
          const t = banDate.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",hour12:true})
            .replace(":00 "," ").replace(" am"," a.m").replace(" pm"," p.m");
          const d = banDate.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
          banLabel = `${t}, ${d}`;
        }
      }
      return `
        <div class="friendRow" style="flex-wrap:wrap;gap:6px;">
          <div class="friendAvatar" style="${u.is_admin?"background:var(--amber)":""}">${u.username.charAt(0).toUpperCase()}</div>
          <div style="flex:1;min-width:120px;">
            <div style="font-weight:600;font-size:13px;">${u.username}${u.is_admin?` <span style="font-size:10px;color:var(--amber);">ADMIN</span>`:""}</div>
            <div style="font-size:11px;color:var(--text-muted);">${u.matches_played} matches</div>
            ${isBanned?`<div style="font-size:11px;color:var(--red);font-weight:600;">${banLabel}</div>`:""}
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btnSecondary" style="font-size:11px;padding:4px 8px;" onclick="openProfile('${u.username}');closePopup('adminPanel');">View</button>
            ${!u.is_admin ? `
              ${isBanned
                ? `<button class="btnPrimary" style="font-size:11px;padding:4px 8px;background:var(--green);" onclick="adminUnban(${u.id},'${u.username}')">Unban</button>`
                : `<button class="btnSecondary" style="font-size:11px;padding:4px 8px;color:var(--amber);border-color:var(--amber);" onclick="adminBanPrompt(${u.id},'${u.username}')">Ban</button>`}
              <button class="btnSecondary" style="font-size:11px;padding:4px 8px;color:var(--red);border-color:var(--red);" onclick="adminDeleteUser(${u.id},'${u.username}')">Delete</button>
            ` : ""}
          </div>
        </div>`;
    }).join("");
  } catch(e) { document.getElementById("adminUserList").innerHTML = `<p class="profileLoading" style="color:var(--red);">Error: ${e.message}</p>`; }
}

async function adminDeleteUser(userId, username) {
  const overlay = document.createElement("div");
  overlay.className = "popupOverlay";
  overlay.style.cssText = "display:flex;z-index:99999;";
  overlay.innerHTML = `
    <div class="popupCard">
      <p class="popupEmoji">🗑️</p><h3>Delete ${username}?</h3>
      <p class="popupMsg" style="color:var(--red);">Permanent. Cannot be undone.</p>
      <div class="btnRow" style="width:100%;">
        <button class="btnPrimary" style="background:var(--red);" id="adConfirm">Yes, Delete</button>
        <button class="btnSecondary" id="adCancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#adCancel").onclick = () => overlay.remove();
  overlay.querySelector("#adConfirm").onclick = async () => {
    overlay.querySelector("#adConfirm").textContent = "Deleting...";
    overlay.querySelector("#adConfirm").disabled = true;
    try {
      const res = await authFetch(AUTH_URL + "/auth/admin/delete-user", {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ userId }),
      });
      const d = await res.json();
      overlay.remove();
      if (res.ok) { showToast("✅ User deleted","var(--green)","#0f172a"); loadAdminUsers(); }
      else showAlert(d.error||"Failed","❌");
    } catch { overlay.remove(); showAlert("Network error","❌"); }
  };
}

function adminBanPrompt(userId, username) {
  const overlay = document.createElement("div");
  overlay.className = "popupOverlay";
  overlay.style.cssText = "display:flex;z-index:99999;";
  overlay.innerHTML = `
    <div class="popupCard">
      <p class="popupEmoji">🔨</p><h3>Ban ${username}?</h3>
      <p class="popupMsg">Enter duration (leave both blank for permanent):</p>
      <div style="display:flex;gap:8px;width:100%;align-items:center;">
        <div style="flex:1;display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px;">Days</label>
          <input type="number" id="banDays"  placeholder="0" min="0" style="text-align:center;">
        </div>
        <div style="color:var(--text-muted);padding-top:20px;">+</div>
        <div style="flex:1;display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px;">Hours</label>
          <input type="number" id="banHours" placeholder="0" min="0" style="text-align:center;">
        </div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:0;text-align:center;">e.g. 2 days + 6 hours = 54 hours total</p>
      <button class="btnPrimary fullWidth" id="banApplyBtn">🔨 Apply Ban</button>
      <button class="btnSecondary fullWidth" id="banPermBtn" style="color:var(--red);border-color:var(--red);">⛔ Permanent Ban</button>
      <button class="btnSecondary fullWidth" id="banCancelBtn">Cancel</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#banCancelBtn").onclick = () => overlay.remove();
  const doBan = async (hours) => {
    overlay.remove();
    try {
      const res = await authFetch(AUTH_URL + "/auth/admin/ban", {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ userId, durationHours:hours }),
      });
      const d = await res.json();
      if (res.ok) { showToast("🔨 "+username+" banned","var(--amber)","#0f172a"); loadAdminUsers(); }
      else showAlert(d.error||"Failed","❌");
    } catch { showAlert("Network error","❌"); }
  };
  overlay.querySelector("#banPermBtn").onclick = () => doBan(0); // 0 = permanent
  overlay.querySelector("#banApplyBtn").onclick = () => {
    const days  = parseInt(overlay.querySelector("#banDays").value)  || 0;
    const hours = parseInt(overlay.querySelector("#banHours").value) || 0;
    const total = days * 24 + hours;
    if (total < 1) { showAlert("Enter at least 1 hour or use Permanent Ban","⚠️"); return; }
    doBan(total);
  };
}

async function adminUnban(userId, username) {
  try {
    const res = await authFetch(AUTH_URL + "/auth/admin/unban", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ userId }),
    });
    if (res.ok) { showToast("✅ "+username+" unbanned","var(--green)","#0f172a"); loadAdminUsers(); }
    else { const d = await res.json(); showAlert(d.error||"Failed","❌"); }
  } catch { showAlert("Network error","❌"); }
}

// ══════════════════════════════════════════════
// ROOM / MATCH FLOW
// ══════════════════════════════════════════════
function generateRoomCode() { return String(Math.floor(1000 + Math.random() * 9000)); }
function toggleTheme() {
  document.body.classList.toggle("light");
  const isLight = document.body.classList.contains("light");
  document.getElementById("themeToggle").textContent = isLight ? "☀️" : "🌙";
  _updateThumbImage();
}

function _updateThumbImage() {
  const isLight = document.body.classList.contains("light");
  const isOpen  = selectedFingers.includes("thumb");
  const dark    = document.getElementById("layer-thumb-dark");
  const light   = document.getElementById("layer-thumb-light");
  if (!dark || !light) return;
  // Exactly one thumb layer open at a time, matching current theme
  dark.classList.toggle("open",   isOpen && !isLight);
  light.classList.toggle("open",  isOpen &&  isLight);
}

function goToRoomSetup() {
  generatedCode = generateRoomCode();
  document.getElementById("oversInput").value = "";
  document.getElementById("wicketsInput").value = "";
  setGameMode("limited");
  showScreen("roomSetupScreen");
}

function setGameMode(mode) {
  gameMode = mode;
  const oversInput = document.getElementById("oversInput");
  document.getElementById("limitedBtn").classList.toggle("active",   mode === "limited");
  document.getElementById("unlimitedBtn").classList.toggle("active", mode === "unlimited");
  if (mode === "unlimited") { oversInput.value = ""; oversInput.disabled = true; oversInput.style.display = "none"; }
  else { oversInput.disabled = false; oversInput.style.display = "block"; }
}

function createRoom() {
  // No client-side ban check — server always enforces via room.js _checkBan
  // This ensures ban/unban takes effect instantly without needing a page refresh
  const overs   = document.getElementById("oversInput").value;
  const wickets = document.getElementById("wicketsInput").value;
  if (gameMode === "limited"   && (!overs || !wickets)) { showAlert("Fill all fields!", "📋"); return; }
  if (gameMode === "unlimited" && !wickets)             { showAlert("Enter wickets!", "🎳"); return; }
  roomCode = generatedCode;
  isHost   = true;
  document.getElementById("lobbyRoomCode").textContent       = roomCode;
  document.getElementById("teamA").textContent               = "Waiting...";
  document.getElementById("teamB").textContent               = "Waiting...";
  document.getElementById("spectatorCount").textContent      = "0";
  document.getElementById("liveSpectatorCount").textContent  = "0";
  document.getElementById("startMatchBtn").style.display     = "none";
  document.getElementById("readyBtn").style.display          = "none";
  connectToServer(roomCode, gameMode === "limited" ? overs : null, wickets, false, true);
  showScreen("lobbyScreen");
}  // end createRoom

function joinRoom() {
  const code = document.getElementById("joinRoomCodeInput").value.trim();
  if (!code) { showAlert("Enter room code!", "🔢"); return; }
  roomCode = code; isHost = false;
  document.getElementById("lobbyRoomCode").textContent      = code;
  document.getElementById("teamA").textContent              = "Waiting...";
  document.getElementById("teamB").textContent              = "Waiting...";
  document.getElementById("teamALabel").textContent         = "Player 1";
  document.getElementById("startMatchBtn").style.display    = "none";
  document.getElementById("readyBtn").style.display         = "none";
  connectToServer(code, null, null, false, false);
}

function spectateRoom() {
  const code = document.getElementById("joinRoomCodeInput").value.trim();
  if (!code) { showAlert("Enter room code!", "🔢"); return; }
  roomCode = code; isHost = false;
  // Reset buffer — _spectatorAwaitingSync is set to true in ROOM_JOINED only
  // when we discover matchStarted=true via SYNC_STATE, so lobby-phase spectators
  // always land in the lobby immediately.
  spectatorSyncBuffer = [];
  window._spectatorAwaitingSync = false;
  connectToServer(code, null, null, true, false);
}

function startMatch() {
  const teamA = document.getElementById("teamA").textContent;
  const teamB = document.getElementById("teamB").textContent;
  const emptyVals = ["Empty", "Waiting...", "", null, undefined];
  // After a HOST_TRANSFER the new host may be in slot B — check both slots
  const aEmpty = emptyVals.includes(teamA) || (teamA && teamA.includes("(disconnected)"));
  const bEmpty = emptyVals.includes(teamB) || (teamB && teamB.includes("(disconnected)"));
  if (aEmpty || bEmpty) { showAlert("Waiting for opponent to join", "⏳"); return; }
  // Also clear the empty-slot tracker since both slots are now filled
  window._hostTransferEmptySlot = null;
  socket.send(JSON.stringify({ type: "START_MATCH" }));
}

function sendReady() {
  socket.send(JSON.stringify({ type: "PLAYER_READY" }));
  const btn = document.getElementById("readyBtn");
  btn.disabled = true; btn.textContent = "✅ Sent!";
  setTimeout(() => { btn.disabled = false; btn.textContent = "✋ Ready to Play!"; }, 1000);
}

function copyRoomCode() {
  navigator.clipboard.writeText(roomCode);
  showToast("✅ Room code copied!", "var(--green)", "#0f172a");
}

// Fix #9: Lobby invite removed

// ══════════════════════════════════════════════
// TOSS / DECISION
// ══════════════════════════════════════════════
function sendToss(choice) {
  if (isTossing) return;
  socket.send(JSON.stringify({ type: "TOSS_CHOICE", player: mySlot, choice }));
  if (choice !== "pass") {
    isTossing = true;
    document.getElementById("tossButtons").style.display = "none";
    document.getElementById("tossMessage").textContent   = "Flipping coin...";
  }
}

function animateCoinFlip(result) {
  const coin = document.getElementById("coin");
  const msg  = document.getElementById("tossMessage");
  const wait = document.getElementById("tossWaiting");
  // Hide sub-text for everyone the moment the coin starts flipping
  wait.style.display  = "none";
  wait.textContent    = "";
  coin.classList.remove("flip-heads","flip-tails");
  void coin.offsetWidth;
  coin.classList.add(result === "head" ? "flip-heads" : "flip-tails");
  msg.textContent = "Coin is in the air...";
  setTimeout(() => {
    msg.textContent = result === "head" ? "It's HEADS! 🟡" : "It's TAILS! 🔵";
    isTossing = false;
  }, 2000);
}

function sendDecision(choice) {
  socket.send(JSON.stringify({ type: "BAT_BOWL_CHOICE", player: mySlot, choice }));
}

// ══════════════════════════════════════════════
// HAND
// ══════════════════════════════════════════════
function toggleHandFinger(finger) {
  if (window.handLocked) return;
  if (finger === "thumb") {
    // Thumb uses two theme-aware layers — no single layer-thumb element
    if (selectedFingers.includes("thumb")) {
      selectedFingers = selectedFingers.filter(f => f !== "thumb");
    } else {
      selectedFingers.push("thumb");
    }
    _updateThumbImage();
  } else {
    const layer = document.getElementById("layer-" + finger);
    if (!layer) return;
    if (selectedFingers.includes(finger)) {
      selectedFingers = selectedFingers.filter(f => f !== finger);
      layer.classList.remove("open");
    } else {
      selectedFingers.push(finger);
      layer.classList.add("open");
    }
  }
  const names = { thumb:"👍 Thumb", index:"☝️ Index", middle:"🖕 Middle", ring:"💍 Ring", pinky:"🤙 Pinky" };
  document.getElementById("selectedDisplay").textContent =
    selectedFingers.length > 0 ? selectedFingers.map(f => names[f]).join(", ") : "None";
}

function lockHand() {
  if (selectedFingers.length === 0) { showAlert("Select at least one finger!", "✋"); return; }
  if (window.handLocked) return;
  window.handLocked = true;
  socket.send(JSON.stringify({ type: "HAND_SELECT", player: mySlot, fingers: selectedFingers }));
  socket.send(JSON.stringify({ type: "HAND_LOCK",   player: mySlot }));
  const rig = document.getElementById("handRig");
  rig.classList.add("locking");
  setTimeout(() => rig.classList.remove("locking"), 300);
  document.getElementById("selectedDisplay").textContent = "🔒 Locked! Waiting...";
}

// ══════════════════════════════════════════════
// DECLARE
// ══════════════════════════════════════════════
function declareMatch() {
  declareFromMenu = false;
  document.getElementById("declarePopup").style.display = "flex";
}
function confirmDeclare() {
  closePopup("declarePopup");
  socket.send(JSON.stringify({ type: "DECLARE" }));
}

// ══════════════════════════════════════════════
// SCOREBOARD
// ══════════════════════════════════════════════
function updateScoreboard(payload) {
  const { battingName, bowlingName, scoreA, scoreB, wicketsA, wicketsB, balls, ballsLeft, innings, target } = payload;
  // Cache permanent display names from payload whenever server sends them
  if (payload.displayNameA) window._displayNames.A = payload.displayNameA;
  if (payload.displayNameB) window._displayNames.B = payload.displayNameB;
  currentBattingName = battingName;
  currentBowlingName = bowlingName;
  // Determine display: if a player is absent, show "Empty" for their role
  const _absentSlot = window._absentSlot || null;
  const _absentName = _absentSlot ? (window._displayNames[_absentSlot] || null) : null;
  const _battingDisplay = (_absentName && battingName === _absentName) ? "Empty" : battingName;
  const _bowlingDisplay = (_absentName && bowlingName === _absentName) ? "Empty" : bowlingName;
  document.getElementById("battingName").textContent = "Batsman: " + _battingDisplay;
  document.getElementById("bowlingName").textContent = "Bowler: " + _bowlingDisplay;
  // Use _displayNames cache — never "Empty" even when player disconnected mid-match
  const _resolvedA     = window._displayNames.A || document.getElementById("teamA").textContent;
  const battingScore   = battingName === _resolvedA ? scoreA : scoreB;
  const battingWickets = battingName === _resolvedA ? wicketsA : wicketsB;
  // Update wicket tracking for first-wicket sound (also use cache)
  if (battingName === _resolvedA) _wicketCountA = battingWickets;
  else _wicketCountB = battingWickets;
  document.getElementById("mainScore").textContent      = battingScore + " - " + battingWickets;
  document.getElementById("inningsDisplay").textContent = "Innings: " + innings;
  document.getElementById("modeDisplay").textContent    = "Single • " + (matchMode === "limited" ? "Limited" : "Unlimited");
  if (matchMode === "limited") {
    document.getElementById("overDisplay").textContent      = Math.floor(balls / 6) + "." + (balls % 6);
    document.getElementById("ballsLeftDisplay").textContent = ballsLeft ?? "-";
  } else {
    document.getElementById("overDisplay").textContent      = "-";
    document.getElementById("ballsLeftDisplay").textContent = "-";
  }
  if (target) {
    const runsLeft = Math.max(target - battingScore, 0);
    document.getElementById("targetDisplay").textContent   = target;
    document.getElementById("runsLeftDisplay").textContent = runsLeft;
    document.getElementById("rrrDisplay").textContent      =
      (matchMode === "limited" && ballsLeft > 0) ? (runsLeft / ballsLeft).toFixed(2) : "-";
  } else {
    document.getElementById("targetDisplay").textContent   = "-";
    document.getElementById("runsLeftDisplay").textContent = "-";
    document.getElementById("rrrDisplay").textContent      = "-";
  }
}

function updateBallHistory(serverBalls, out, lastRuns) {
  localBallCount++;
  const ballRun = out ? "W" : lastRuns;
  if (lastBalls.length >= 6) lastBalls = [];
  lastBalls.push(ballRun);
  const boxes = document.querySelectorAll(".ballBox");
  boxes.forEach((box, i) => { box.textContent = lastBalls[i] !== undefined ? lastBalls[i] : "-"; box.classList.remove("ballFlash"); });
  if (boxes[lastBalls.length - 1]) {
    boxes[lastBalls.length - 1].classList.add("ballFlash");
    setTimeout(() => boxes[lastBalls.length - 1]?.classList.remove("ballFlash"), 500);
  }
}

function showBallMessage(out, lastRuns) {
  const msg = document.getElementById("ballMessage");
  if (out) {
    // First wicket of the batting team → play special sound, rest → normal
    const _resolvedAForWicket = window._displayNames.A || document.getElementById("teamA").textContent;
    const battingWicketCount = currentBattingName === _resolvedAForWicket ? _wicketCountA : _wicketCountB;
    const isFirstWicket = matchWickets > 1 && battingWicketCount === 1;
    window.playSound(isFirstWicket ? "firstWicket" : "wicket");
    msg.textContent = "WICKET! 🔴"; msg.style.color = "var(--red)";
  }
  else if (lastRuns === 6) { window.playSound("six"); msg.textContent = "SIX! 🚀"; msg.style.color = "var(--amber)"; }
  else if (lastRuns === 4) { msg.textContent = "FOUR! 💥"; msg.style.color = "var(--green)"; }
  else if (lastRuns === 0) { msg.textContent = "DOT BALL •"; msg.style.color = "var(--text-muted)"; }
  else { msg.textContent = lastRuns + (lastRuns === 1 ? " RUN" : " RUNS"); msg.style.color = "var(--text)"; }
}

function resetLockBar() {
  document.getElementById("lockStatusA").classList.remove("locked");
  document.getElementById("lockStatusB").classList.remove("locked");
  document.getElementById("lockStateA").textContent = "Waiting ⏳";
  document.getElementById("lockStateB").textContent = "Waiting ⏳";
  document.getElementById("lockStatusBar").style.display = "none";
}

function resetGameScreenForInnings(inningsNum) {
  lastBalls = []; localBallCount = 0; selectedFingers = [];
  _wicketCountA = 0; _wicketCountB = 0;
  document.querySelectorAll(".handLayer").forEach(l => { if (!l.classList.contains("base")) l.classList.remove("open"); });
  document.getElementById("selectedDisplay").textContent      = "None";
  document.getElementById("mainScore").textContent            = "0 - 0";
  document.getElementById("overDisplay").textContent          = "0.0";
  document.getElementById("ballsLeftDisplay").textContent     = matchMode === "limited" ? String(matchOvers * 6) : "-";
  document.getElementById("runsLeftDisplay").textContent      = "-";
  document.getElementById("rrrDisplay").textContent           = "-";
  document.getElementById("inningsDisplay").textContent       = "Innings: " + inningsNum;
  document.getElementById("ballMessage").textContent          = "";
  document.querySelectorAll(".ballBox").forEach(b => b.textContent = "-");
  window.handLocked = false;
  resetLockBar();
  if (isSpectator) {
    document.querySelector(".handContainer").style.display = "none";
    document.querySelector(".btnLock").style.display       = "none";
    document.querySelector(".controlLabel").style.display  = "none";
    document.querySelector(".selectedLabel").style.display = "none";
    document.getElementById("ballMessage").textContent     = "Watching the match...";
  }
}

function updateDeclareBtn() {
  const active  = document.querySelector(".screen.active");
  const isGame  = active && active.id === "gameScreen";
  const isBatter2 = isGame && !isSpectator && currentInnings === 2
    && ((mySlot === "A" && currentBattingName === document.getElementById("teamA").textContent)
     || (mySlot === "B" && currentBattingName === document.getElementById("teamB").textContent));
  document.getElementById("gameDeclareBtn").style.display = isBatter2 ? "block" : "none";
}

// ══════════════════════════════════════════════
// PREVIEW / BREAK COUNTDOWNS
// ══════════════════════════════════════════════
function _applyMatchDecision(p) {
  matchMode = p.mode; matchOvers = p.overs || 0; matchWickets = p.wicketsLimit || 0;
  currentBattingName = p.batting; currentBowlingName = p.bowling;
  document.getElementById("previewBattingName").textContent = p.batting;
  document.getElementById("previewBowlingName").textContent = p.bowling;
  document.getElementById("previewMode").textContent    = matchMode === "limited" ? "Limited" : "Unlimited";
  document.getElementById("previewOvers").textContent   = matchMode === "limited" ? matchOvers : "∞";
  document.getElementById("previewWickets").textContent = matchWickets;
  document.getElementById("battingName").textContent    = "Batsman: " + p.batting;
  document.getElementById("bowlingName").textContent    = "Bowler: " + p.bowling;
  document.getElementById("modeDisplay").textContent    = "Single • " + (matchMode === "limited" ? "Limited" : "Unlimited");
  lastBalls = []; localBallCount = 0; currentInnings = 1;
}

function startPreviewCountdown() {
  let secs = 5;
  document.getElementById("previewCountdownNum").textContent = secs;
  if (previewCountdownTimer) clearInterval(previewCountdownTimer);
  previewCountdownTimer = setInterval(() => {
    secs--;
    document.getElementById("previewCountdownNum").textContent = secs;
    if (secs <= 0) { clearInterval(previewCountdownTimer); previewCountdownTimer = null; startFromPreview(); }
  }, 1000);
}

function skipPreview() {
  if (previewCountdownTimer) { clearInterval(previewCountdownTimer); previewCountdownTimer = null; }
  startFromPreview();
}

function startFromPreview() {
  if (window._spectatorSkipReset) {
    // SYNC_STATE already populated the scoreboard — do NOT reset, just go to game
    window._spectatorSkipReset = false;
    // Merge any balls that arrived during the preview countdown into lastBalls
    if (syncedBallHistory.length > 0) {
      lastBalls = [...syncedBallHistory];
      syncedBallHistory = [];
      const boxes = document.querySelectorAll(".ballBox");
      boxes.forEach((box, i) => { box.textContent = lastBalls[i] !== undefined ? lastBalls[i] : "-"; });
    }
    // Restore spectator UI state
    if (isSpectator) {
      document.querySelector(".handContainer").style.display = "none";
      document.querySelector(".btnLock").style.display       = "none";
      document.querySelector(".controlLabel").style.display  = "none";
      document.querySelector(".selectedLabel").style.display = "none";
      document.getElementById("lockStatusBar").style.display = "flex";
      document.getElementById("ballMessage").textContent     = "Watching the match...";
    }
    showScreen("gameScreen");
    return;
  }
  // Normal fresh start — reset then optionally restore synced ball history
  const stash = [...syncedBallHistory];
  resetGameScreenForInnings(currentInnings);
  if (stash.length > 0) {
    lastBalls = stash; syncedBallHistory = [];
    const boxes = document.querySelectorAll(".ballBox");
    boxes.forEach((box, i) => { box.textContent = lastBalls[i] !== undefined ? lastBalls[i] : "-"; });
  }
  showScreen("gameScreen");
}

function startBreakCountdown() {
  let secs = 5;
  document.getElementById("breakCountdownNum").textContent = secs;
  if (breakCountdownTimer) clearInterval(breakCountdownTimer);
  breakCountdownTimer = setInterval(() => {
    secs--;
    document.getElementById("breakCountdownNum").textContent = secs;
    if (secs <= 0) { clearInterval(breakCountdownTimer); breakCountdownTimer = null; goToInnings2(); }
  }, 1000);
}

function skipBreak() {
  if (breakCountdownTimer) { clearInterval(breakCountdownTimer); breakCountdownTimer = null; }
  goToInnings2();
}

function goToInnings2() {
  if (window._spectatorSkipReset) {
    window._spectatorSkipReset = false;
    if (isSpectator) {
      document.querySelector(".handContainer").style.display = "none";
      document.querySelector(".btnLock").style.display       = "none";
      document.querySelector(".controlLabel").style.display  = "none";
      document.querySelector(".selectedLabel").style.display = "none";
      document.getElementById("lockStatusBar").style.display = "flex";
      document.getElementById("ballMessage").textContent     = "Watching the match...";
    }
    showScreen("gameScreen");
    return;
  }
  resetGameScreenForInnings(2);
  showScreen("gameScreen");
}

// ══════════════════════════════════════════════
// RESULT SCREEN
// ══════════════════════════════════════════════
function displayMatchResult(data) {
  const { winner, scoreA, scoreB, wicketsA, wicketsB, ballsLeft, declared, ballsPlayed } = data;
  // Cache display names from result payload if provided
  if (data.displayNameA) window._displayNames.A = data.displayNameA;
  if (data.displayNameB) window._displayNames.B = data.displayNameB;
  // Always use permanent display name cache — DOM may show "Empty" if player disconnected
  const teamAName = window._displayNames.A || document.getElementById("teamA").textContent;
  const teamBName = window._displayNames.B || document.getElementById("teamB").textContent;
  // Restore scoreboard slot names to real names for result screen
  document.getElementById("teamA").textContent = teamAName;
  document.getElementById("teamB").textContent = teamBName;

  document.getElementById("matchSummary").style.display = "block";
  document.getElementById("matchStats").style.display   = "block";

  const isDraw = winner === "Draw";
  document.getElementById("resultEmoji").textContent = isDraw ? "🤝" : "🏆";
  document.getElementById("resultTitle").textContent  = isDraw ? "It's a Draw!" : "Match Over!";

  const declaredEl = document.getElementById("declaredText");
  if (declared) {
    document.getElementById("winnerText").textContent = isDraw ? "Match Drawn" : "🎉 " + winner + " Wins!";
    document.getElementById("marginText").textContent = (data.declaredBy || "A player") + " declared the match";
    declaredEl.style.display = "block";
    const op = ballsPlayed ? Math.floor(ballsPlayed/6)+"."+ballsPlayed%6 : "—";
    declaredEl.textContent = `⚡ Declared after ${op} overs`;
  } else if (isDraw) {
    document.getElementById("winnerText").textContent = "Match Drawn";
    document.getElementById("marginText").textContent = "Both teams scored equal runs";
    declaredEl.style.display = "none";
  } else {
    document.getElementById("winnerText").textContent = "🎉 " + winner + " Wins!";
    // Determine winner slot robustly — avoid negative margin when a player name
    // briefly shows as null/"Empty" because a player left before result arrived
    const winnerIsA = winner === teamAName
      || (winner !== teamBName && scoreA > scoreB);
    const winnerScore = winnerIsA ? scoreA : scoreB;
    const loserScore  = winnerIsA ? scoreB : scoreA;
    const runMargin   = Math.max(0, winnerScore - loserScore);
    document.getElementById("marginText").textContent =
      ballsLeft !== null && ballsLeft > 0
        ? `Won by ${runMargin} run${runMargin!==1?"s":""} with ${ballsLeft} ball${ballsLeft!==1?"s":""} remaining`
        : `Won by ${runMargin} run${runMargin!==1?"s":""}`;
    declaredEl.style.display = "none";
  }

  document.getElementById("team1Name").textContent     = teamAName + ":";
  document.getElementById("team1Score").textContent    = scoreA + "-" + wicketsA;
  document.getElementById("team2Name").textContent     = teamBName + ":";
  document.getElementById("team2Score").textContent    = scoreB + "-" + wicketsB;
  document.getElementById("ballsRemaining").textContent = ballsLeft !== null ? ballsLeft : "—";

  // Clean up old spectator choices
  document.getElementById("spectatorRematchChoice")?.remove();
  document.getElementById("exitMatchBtn").style.display = "none";

  // Store opponent info for friend system
  window._resultOppUsername    = mySlot === "A" ? (data.usernameB || "") : (data.usernameA || "");
  window._resultOppDisplayName = mySlot === "A" ? teamBName : teamAName;

  if (isSpectator) {
    document.getElementById("rematchBtn").style.display          = "none";
    document.getElementById("rematchReceiverBtns").style.display = "none";
    document.getElementById("rematchStatus").textContent         = "Waiting to see if players rematch...";
    document.getElementById("rematchSection").style.display      = "block";
    document.getElementById("friendSection").style.display       = "none";
  } else {
    // Rematch reset
    document.getElementById("rematchBtn").style.display          = "block";
    document.getElementById("rematchBtn").textContent            = "🔄 Request Rematch";
    document.getElementById("rematchBtn").disabled               = false;
    document.getElementById("rematchReceiverBtns").style.display = "none";
    document.getElementById("rematchStatus").textContent         = "";
    document.getElementById("rematchSection").style.display      = "block";

    // Friend section — check real DB state so we show correct status on load
    const hasOpp = window._resultOppUsername && window._resultOppUsername !== "Empty" && window._resultOppUsername !== "Waiting...";
    if (hasOpp) {
      document.getElementById("friendSection").style.display = "block";
      _initFriendSection(window._resultOppUsername, window._resultOppDisplayName);
    } else {
      document.getElementById("friendSection").style.display = "none";
    }
  }
}

// ── Friend section on result screen ──────────────────────────────────────────
// Checks real DB state on load: already friends / pending / sent / nothing
async function _initFriendSection(oppUsername, oppDisplayName) {
  const addBtn      = document.getElementById("friendAddBtn");
  const receiverBtns = document.getElementById("friendReceiverBtns");
  const status      = document.getElementById("friendStatus");

  // Reset to loading state
  addBtn.style.display      = "none";
  receiverBtns.style.display = "none";
  status.textContent        = "Loading...";

  try {
    const res  = await authFetch(AUTH_URL + "/auth/friends");
    const data = await res.json();
    const isFriend  = (data.friends || []).some(f => f.username === oppUsername);
    const isSent    = (data.sent    || []).some(f => f.username === oppUsername);
    const isPending = (data.pending || []).some(f => f.username === oppUsername);

    if (isFriend) {
      status.textContent = "✅ Already friends with " + oppDisplayName;
    } else if (isSent) {
      // We already sent a request they haven't responded to yet
      status.textContent = "⏳ Request already sent to " + oppDisplayName + " — waiting...";
    } else if (isPending) {
      // They already sent us a request — show accept/decline
      status.textContent = "👥 " + oppDisplayName + " wants to be friends!";
      receiverBtns.style.display = "flex";
    } else {
      status.textContent = "";
      addBtn.textContent  = "👥 Add " + oppDisplayName + " as Friend";
      addBtn.disabled     = false;
      addBtn.style.display = "block";
    }
  } catch {
    status.textContent = "";
    addBtn.textContent  = "👥 Add " + oppDisplayName + " as Friend";
    addBtn.disabled     = false;
    addBtn.style.display = "block";
  }
}

async function requestFriend() {
  const opp = window._resultOppUsername;
  if (!opp) return;
  const addBtn = document.getElementById("friendAddBtn");
  addBtn.disabled = true;
  addBtn.textContent = "Sending...";
  try {
    const res = await authFetch(AUTH_URL + "/auth/friends/request", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: opp }),
    });
    if (res && res.ok) {
      // DB record created — now notify opponent via WS
      socket.send(JSON.stringify({ type: "FRIEND_REQUEST", payload: { fromUsername: authUsername, fromDisplayName: authDisplayName } }));
      addBtn.style.display = "none";
      document.getElementById("friendStatus").textContent = "⏳ Waiting for " + window._resultOppDisplayName + "...";
    } else {
      addBtn.disabled    = false;
      addBtn.textContent = "👥 Add " + window._resultOppDisplayName + " as Friend";
    }
  } catch {
    addBtn.disabled    = false;
    addBtn.textContent = "👥 Add " + window._resultOppDisplayName + " as Friend";
  }
}

function acceptFriend() {
  const opp = window._resultOppUsername;
  if (!opp) return;
  authFetch(AUTH_URL + "/auth/friends/respond", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ fromUsername: opp, action: "accept" }),
  }).catch(() => {});
  socket.send(JSON.stringify({
    type: "FRIEND_RESPOND",
    payload: { action:"accept", fromDisplayName: window._resultOppDisplayName, toDisplayName: authDisplayName },
  }));
  document.getElementById("friendReceiverBtns").style.display = "none";
  document.getElementById("friendStatus").textContent = "✅ You and " + window._resultOppDisplayName + " are now friends!";
}

function declineFriend() {
  const opp = window._resultOppUsername;
  if (!opp) return;
  authFetch(AUTH_URL + "/auth/friends/respond", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ fromUsername: opp, action: "decline" }),
  }).catch(() => {});
  socket.send(JSON.stringify({
    type: "FRIEND_RESPOND",
    payload: { action:"decline", fromDisplayName: window._resultOppDisplayName, toDisplayName: authDisplayName },
  }));
  document.getElementById("friendReceiverBtns").style.display = "none";
  document.getElementById("friendStatus").textContent = "❌ You declined.";
  setTimeout(() => {
    document.getElementById("friendAddBtn").textContent   = "👥 Add " + window._resultOppDisplayName + " as Friend";
    document.getElementById("friendAddBtn").disabled      = false;
    document.getElementById("friendAddBtn").style.display = "block";
    document.getElementById("friendStatus").textContent   = "";
  }, 600);
}

// ══════════════════════════════════════════════
// REMATCH
// ══════════════════════════════════════════════
function requestRematch() {
  socket.send(JSON.stringify({ type: "REMATCH_REQUEST", player: mySlot }));
  document.getElementById("rematchBtn").style.display = "none";
  document.getElementById("rematchStatus").textContent = "⏳ Waiting for opponent...";
}
function acceptRematch() {
  socket.send(JSON.stringify({ type: "REMATCH_ACCEPT", player: mySlot }));
  document.getElementById("rematchReceiverBtns").style.display = "none";
  document.getElementById("rematchStatus").textContent = "✅ Accepted! Starting...";
}
function declineRematch() {
  socket.send(JSON.stringify({ type: "REMATCH_DECLINE", player: mySlot }));
  document.getElementById("rematchReceiverBtns").style.display = "none";
  document.getElementById("rematchStatus").textContent = "❌ You declined.";
}

function watchRematch() {
  // spectatorSyncBuffer keeps buffering until SYNC_STATE is processed.
  // SYNC_STATE handler will clear it after consuming any buffered messages.
  window._spectatorTossAnimating = false;
  window._spectatorAwaitingSync = true;   // gate: buffer all live messages until SYNC_STATE arrives
  document.getElementById("spectatorRematchChoice")?.remove();
  socket.send(JSON.stringify({ type: "SYNC_REQUEST" }));
}

// ══════════════════════════════════════════════
// SPECTATOR BUFFER REPLAY
// Dispatches a previously-buffered message as if it just arrived live.
// Called from SYNC_STATE after routing spectator to the correct screen.
// ══════════════════════════════════════════════
function _dispatchSpectatorBuffered(data) {
  // These are the only message types that can be buffered
  if (data.type === "TOSS_CALLER") {
    showScreen("tossScreen");
    document.getElementById("coin").classList.remove("flip-heads", "flip-tails");
    isTossing = false;
    const _dcCallerName = data.payload.caller === "A" ? document.getElementById("teamA").textContent : document.getElementById("teamB").textContent;
    document.getElementById("tossButtons").style.display = "none";
    document.getElementById("tossWaiting").style.display = "block";
    document.getElementById("tossWaiting").textContent   = "Waiting for " + _dcCallerName + "'s toss...";
    document.getElementById("tossMessage").textContent   = _dcCallerName + " is tossing...";
    return;
  }
  if (data.type === "TOSS_RESULT") {
    window._spectatorTossAnimating = true;
    animateCoinFlip(data.payload.coin);
    window._tossResultTimer = setTimeout(() => {
      window._tossResultTimer = null;
      window._spectatorTossAnimating = false;
      showScreen("decisionScreen");
      document.getElementById("decisionWaiting").textContent =
        "🪙 " + data.payload.coin.toUpperCase() + " — " + data.payload.winner + " won the toss!";
      document.getElementById("decisionButtons").style.display = "none";
      document.getElementById("decisionWaiting").style.display = "block";
    }, 2500);
    return;
  }
  if (data.type === "MATCH_DECISION") {
    if (window._spectatorTossAnimating) {
      if (window._tossResultTimer) { clearTimeout(window._tossResultTimer); window._tossResultTimer = null; }
      window._spectatorTossAnimating = false;
    }
    _applyMatchDecision(data.payload);
    showScreen("matchPreviewScreen");
    updateDeclareBtn();
    startPreviewCountdown();
    return;
  }
  if (data.type === "BALL_RESULT") {
    window.handLocked = false; selectedFingers = [];
    updateScoreboard(data.payload); updateDeclareBtn();
    updateBallHistory(data.payload.balls, data.payload.out, data.payload.lastRuns);
    showBallMessage(data.payload.out, data.payload.lastRuns);
    if (data.payload.matchOver) {
      setTimeout(() => { displayMatchResult(data.payload); showScreen("resultScreen"); }, 900);
    }
    return;
  }
  if (data.type === "INNINGS_BREAK") {
    window.handLocked = false;
    const p = data.payload;
    currentBattingName = p.nextBattingName; currentBowlingName = p.nextBowlingName;
    // Use _displayNames fallback so disconnected player's name still shows
    const _inn1BatterSlot = currentBattingName === (window._displayNames.A || "") ? "B" : "A";
    document.getElementById("breakBattedName").textContent  = p.nextBowlingName || window._displayNames[_inn1BatterSlot] || "—";
    document.getElementById("breakScore1").textContent      = p.innings1Score + " / " + p.innings1Wickets;
    document.getElementById("breakTarget").textContent      = p.target;
    document.getElementById("breakBattingNext").textContent = p.nextBattingName || window._displayNames[_inn1BatterSlot === "A" ? "B" : "A"] || "—";
    document.getElementById("breakModeInfo").textContent    = p.mode === "limited"
      ? "Needs " + p.target + " in " + (p.overs * 6) + " balls"
      : "Needs " + p.target + " runs (no ball limit)";
    currentInnings = 2; updateDeclareBtn();
    setTimeout(() => { lastBalls = []; localBallCount = 0; showScreen("inningsBreakScreen"); startBreakCountdown(); }, 900);
    return;
  }
}

// ══════════════════════════════════════════════
// PLAYER RECONNECT — restore exact game state
// Called only when window._playerReconnecting is true (player, not spectator).
// Routes to the correct screen based on server state, mirroring normal flow.
// ══════════════════════════════════════════════
function _handlePlayerReconnectSync(p) {
  document.getElementById("teamA").textContent = p.playerA || "Empty";
  document.getElementById("teamB").textContent = p.playerB || "Empty";

  // Match already finished — rebuild result screen from sync payload
  if (p.matchStopped) {
    if (p.displayNameA) window._displayNames.A = p.displayNameA;
    if (p.displayNameB) window._displayNames.B = p.displayNameB;
    const dnA = p.displayNameA || p.playerA || "Player A";
    const dnB = p.displayNameB || p.playerB || "Player B";
    document.getElementById("teamA").textContent = dnA;
    document.getElementById("teamB").textContent = dnB;
    // Use stored lastResult if available (has ballsLeft, declared, username, etc.)
    if (p.lastResult) {
      const lr = Object.assign({}, p.lastResult, {
        displayNameA: dnA, displayNameB: dnB,
      });
      displayMatchResult(lr);
    } else {
      let winner;
      if (p.scoreA > p.scoreB)      winner = dnA;
      else if (p.scoreB > p.scoreA) winner = dnB;
      else                          winner = "Draw";
      displayMatchResult({
        winner,
        scoreA: p.scoreA, scoreB: p.scoreB,
        wicketsA: p.wicketsA, wicketsB: p.wicketsB,
        ballsLeft: null, declared: false,
        displayNameA: dnA, displayNameB: dnB,
        usernameA: null, usernameB: null,
      });
    }
    showScreen("resultScreen");
    return;
  }

  // ── Toss / Decision phase (battingTeam not yet set) ──────────────────────
  if (!p.battingTeam) {

    // Coin currently flipping — animate then show decision
    if (p.tossFlipping) {
      showScreen("tossScreen");
      document.getElementById("tossButtons").style.display = "none";
      document.getElementById("tossWaiting").style.display = "block";
      document.getElementById("coin").classList.remove("flip-heads", "flip-tails");
      isTossing = true;
      animateCoinFlip(p.tossResult || "head");
      const winnerName = p.tossWinnerSlot === "A" ? p.playerA : p.playerB;
      setTimeout(() => {
        isTossing = false;
        showScreen("decisionScreen");
        document.getElementById("decisionWaiting").textContent =
          "🪙 " + (p.tossResult || "head").toUpperCase() + " — " + winnerName + " won the toss!";
        const amIWinner = mySlot === p.tossWinnerSlot;
        document.getElementById("decisionButtons").style.display = amIWinner ? "flex" : "none";
        document.getElementById("decisionWaiting").style.display = "block";
      }, 2500);
      return;
    }

    // Toss done, winner known — I may or may not be the one choosing bat/bowl
    if (p.tossWinnerSlot) {
      const winnerName = p.tossWinnerSlot === "A" ? p.playerA : p.playerB;
      showScreen("decisionScreen");
      document.getElementById("decisionWaiting").textContent =
        "🪙 " + (p.tossResult ? p.tossResult.toUpperCase() + " — " : "") + winnerName + " won the toss!";
      const amIWinner = mySlot === p.tossWinnerSlot;
      document.getElementById("decisionButtons").style.display = amIWinner ? "flex" : "none";
      document.getElementById("decisionWaiting").style.display = "block";
      return;
    }

    // Someone is choosing H/T — might be me
    if (p.tossCaller) {
      showScreen("tossScreen");
      document.getElementById("coin").classList.remove("flip-heads", "flip-tails");
      isTossing = false;
      const iAmCaller = mySlot === p.tossCaller;
      document.getElementById("tossButtons").style.display  = iAmCaller ? "flex" : "none";
      document.getElementById("tossWaiting").style.display  = iAmCaller ? "none" : "block";
      const oppCallerName = p.tossCaller === "A" ? (document.getElementById("teamA").textContent||"Opponent") : (document.getElementById("teamB").textContent||"Opponent");
      document.getElementById("tossWaiting").textContent    = iAmCaller ? "" : "Waiting for " + oppCallerName + "'s toss...";
      document.getElementById("tossMessage").textContent    = iAmCaller ? "Make your call!" : oppCallerName + " is tossing...";
      return;
    }

    // Match started but toss not assigned yet (race condition guard)
    showScreen("tossScreen");
    document.getElementById("tossButtons").style.display = "none";
    document.getElementById("tossWaiting").style.display = "block";
    document.getElementById("coin").classList.remove("flip-heads", "flip-tails");
    isTossing = false;
    document.getElementById("tossMessage").textContent = "Waiting for match to start...";
    return;
  }

  // ── Running match — restore full scoreboard ───────────────────────────────
  currentBattingName = p.battingName;
  currentBowlingName = p.bowlingName;

  document.getElementById("battingName").textContent    = "Batsman: " + p.battingName;
  document.getElementById("bowlingName").textContent    = "Bowler: "  + p.bowlingName;
  document.getElementById("modeDisplay").textContent    = "Single • " + (p.mode === "limited" ? "Limited" : "Unlimited");
  document.getElementById("inningsDisplay").textContent = "Innings: " + p.currentInnings;

  const battingScore   = p.battingTeam === "A" ? p.scoreA : p.scoreB;
  const battingWickets = p.battingTeam === "A" ? p.wicketsA : p.wicketsB;
  document.getElementById("mainScore").textContent   = battingScore + " - " + battingWickets;

  const balls      = p.balls;
  const totalBalls = p.overs * 6;
  if (p.mode === "limited") {
    document.getElementById("overDisplay").textContent      = Math.floor(balls / 6) + "." + (balls % 6);
    document.getElementById("ballsLeftDisplay").textContent = totalBalls - balls;
  } else {
    document.getElementById("overDisplay").textContent      = "-";
    document.getElementById("ballsLeftDisplay").textContent = "-";
  }
  if (p.target) {
    const rl = Math.max(p.target - battingScore, 0);
    const bl = totalBalls - balls;
    document.getElementById("targetDisplay").textContent   = p.target;
    document.getElementById("runsLeftDisplay").textContent = rl;
    document.getElementById("rrrDisplay").textContent      =
      (p.mode === "limited" && bl > 0) ? (rl / bl).toFixed(2) : "-";
  } else {
    document.getElementById("targetDisplay").textContent   = "-";
    document.getElementById("runsLeftDisplay").textContent = "-";
    document.getElementById("rrrDisplay").textContent      = "-";
  }

  // Ball history
  lastBalls = (p.ballHistory && p.ballHistory.length > 0) ? [...p.ballHistory] : [];
  document.querySelectorAll(".ballBox").forEach((box, i) => {
    box.textContent = lastBalls[i] !== undefined ? lastBalls[i] : "-";
  });

  // Lock status bar — hidden for rejoining players (only spectators see it on join)
  // It will appear naturally on the next LOCK_STATUS broadcast when either player locks.
  document.getElementById("lockStatusBar").style.display = "none";
  // Still populate names/states so the bar is correct when it does appear
  document.getElementById("lockNameA").textContent       = window._displayNames.A || p.displayNameA || p.playerA || "Player A";
  document.getElementById("lockNameB").textContent       = window._displayNames.B || p.displayNameB || p.playerB || "Player B";
  document.getElementById("lockStatusA").classList.toggle("locked", p.lockedA);
  document.getElementById("lockStatusB").classList.toggle("locked", p.lockedB);
  document.getElementById("lockStateA").textContent      = p.lockedA ? "Locked 🔒" : "Waiting ⏳";
  document.getElementById("lockStateB").textContent      = p.lockedB ? "Locked 🔒" : "Waiting ⏳";

  // Always reset hand visuals first — prevents stale open-finger state from a
  // resolved ball (server resets locked[] after every ball, but selectedFingers[]
  // may linger if the player disconnected before the next ball started)
  document.querySelectorAll(".handLayer").forEach(l => { if (!l.classList.contains("base")) l.classList.remove("open"); });
  selectedFingers   = [];
  _updateThumbImage(); // ensure thumb resets correctly for current theme
  window.handLocked = false;
  document.getElementById("selectedDisplay").textContent = "None";

  // Only restore the locked-hand visual if the ball is genuinely still in-flight:
  // I locked, but opponent has NOT locked yet — ball hasn't resolved.
  // Any other case (both locked → ball resolved → server reset locked[] to false)
  // means the ball is done and the hand should start fresh.
  const myLocked  = mySlot === "A" ? p.lockedA  : p.lockedB;
  const oppLocked = mySlot === "A" ? p.lockedB  : p.lockedA;
  const ballPending = myLocked && !oppLocked;

  if (ballPending) {
    const myFingers = mySlot === "A" ? p.selectedFingersA : p.selectedFingersB;
    if (myFingers && myFingers.length > 0) {
      window.handLocked = true;
      selectedFingers   = [...myFingers];
      myFingers.forEach(f => {
        if (f === "thumb") { _updateThumbImage(); }
        else { const layer = document.getElementById("layer-" + f); if (layer) layer.classList.add("open"); }
      });
      document.getElementById("selectedDisplay").textContent = "🔒 Locked! Waiting...";
    }
  }

  // Show match preview briefly (with skip button) then go to game
  document.getElementById("previewBattingName").textContent = p.battingName;
  document.getElementById("previewBowlingName").textContent = p.bowlingName;
  document.getElementById("previewMode").textContent        = p.mode === "limited" ? "Limited" : "Unlimited";
  document.getElementById("previewOvers").textContent       = p.mode === "limited" ? p.overs : "∞";
  document.getElementById("previewWickets").textContent     = p.wicketsLimit;

  // _spectatorSkipReset prevents startFromPreview from wiping the restored scoreboard
  window._spectatorSkipReset = true;
  showScreen("matchPreviewScreen");
  updateDeclareBtn();
  startPreviewCountdown();
}

// ══════════════════════════════════════════════
// SERVER CONNECTION
// ══════════════════════════════════════════════
function connectToServer(code, overs, wickets, spectate = false, isCreating = false) {
  socket = new WebSocket(WS_URL + "/" + code);

  socket.onopen = () => {
    const name = (authDisplayName && authDisplayName !== "null") ? authDisplayName : authUsername;
    if (isCreating) {
      socket.send(JSON.stringify({
        type: "CREATE_ROOM",
        payload: { playerName: name, overs, wickets, mode: gameMode, token: authToken },
      }));
    } else {
      socket.send(JSON.stringify({
        type: "JOIN_ROOM",
        payload: { playerName: name, spectate, token: authToken },
      }));
    }
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "AUTH_ERROR") {
      clearAuth(); showAlert("Session expired. Please log in again.", "🔒");
      setTimeout(() => location.reload(), 1500); return;
    }

    if (data.type === "BANNED") {
      isSpectator = false; document.getElementById("spectatorBadge").classList.remove("visible");
      showAlert(data.payload.message, "🚫");
      switchTab("homeScreen","navHome");
      if (socket) { socket.close(); socket = null; } return;
    }

    // Fix #10: Ban enforced at room level — show message + offer spectate
    if (data.type === "BANNED_CREATE") {
      // Sync authBan from server response so memory is up to date
      authBan = { active: true, permanent: data.payload.permanent, until: data.payload.until };
      if (socket) { socket.close(); socket = null; }
      showAlert(getBanMessage(data.payload, "You can only spectate matches."), "🚫", () => {
        switchTab("homeScreen", "navHome");
        loadHomeData();
      });
      return;
    }

    if (data.type === "BANNED_JOIN") {
      // Sync authBan from server response so memory is up to date
      authBan = { active: true, permanent: data.payload.permanent, until: data.payload.until };
      const overlay = document.createElement("div");
      overlay.className = "popupOverlay";
      overlay.style.cssText = "display:flex;z-index:99999;";
      const banMsg = getBanMessage(data.payload, "You can only spectate matches.");
      overlay.innerHTML = `<div class="popupCard"><p class="popupEmoji">🚫</p><p style="font-family:var(--font-display);font-size:18px;font-weight:700;margin:0;">Access Restricted</p><p class="popupMsg">${banMsg}</p><div class="btnRow" style="width:100%;"><button class="btnPrimary" id="bjSpectate">👁️ Spectate</button><button class="btnSecondary" id="bjBack">Back</button></div></div>`;
      document.body.appendChild(overlay);
      overlay.querySelector("#bjSpectate").onclick = () => {
        overlay.remove();
        if (socket) { socket.close(); socket = null; }
        const c = document.getElementById("joinRoomCodeInput").value.trim() || roomCode;
        roomCode = c; connectToServer(c, null, null, true, false);
      };
      overlay.querySelector("#bjBack").onclick = () => {
        overlay.remove();
        if (socket) { socket.close(); socket = null; }
      };
      return;
    }

    if (data.type === "OPPONENT_RECONNECTED") {
      const reconName = data.payload.name;
      const reconSlot = data.payload.slot || null;
      showToast("✅ " + reconName + " reconnected!", "var(--green)", "#0f172a");
      const teamAEl = document.getElementById("teamA");
      const teamBEl = document.getElementById("teamB");
      const isSlotA = reconSlot === "A" || (!reconSlot && (window._displayNames.A === reconName || teamAEl.textContent === "Empty"));
      // Clear absent-slot tracker so updateScoreboard stops overriding with "Empty"
      if (isSlotA && window._absentSlot === "A") window._absentSlot = null;
      if (!isSlotA && window._absentSlot === "B") window._absentSlot = null;
      // Restore lobby slot name
      if (isSlotA) teamAEl.textContent = reconName;
      else         teamBEl.textContent = reconName;
      // Restore scoreboard batting/bowling name instantly
      const battingEl = document.getElementById("battingName");
      const bowlingEl = document.getElementById("bowlingName");
      if (battingEl && battingEl.textContent === "Batsman: Empty") {
        battingEl.textContent = "Batsman: " + reconName;
        currentBattingName = reconName;
      }
      if (bowlingEl && bowlingEl.textContent === "Bowler: Empty") {
        bowlingEl.textContent = "Bowler: " + reconName;
        currentBowlingName = reconName;
      }
      // Lock bar names are NOT touched — they always show real names already
      // Close "opponent left" popup if still showing
      const olp = document.getElementById("opponentLeftPopup");
      if (olp && olp.style.display !== "none") closePopup("opponentLeftPopup");
      return;
    }

    if (data.type === "ROOM_NOT_FOUND") {
      isSpectator = false; document.getElementById("spectatorBadge").classList.remove("visible");
      showAlert(data.payload.message, "🚫");
      switchTab("homeScreen","navHome");
      if (socket) { socket.close(); socket = null; } return;
    }

    if (data.type === "ROOM_JOINED") {
      authBan = null;
      roomCode = data.payload.roomCode;
      mySlot   = data.payload.slot;
      document.getElementById("lobbyRoomCode").textContent = roomCode;

      // Player reconnecting mid-match — server follows immediately with SYNC_STATE
      if (data.payload.isReconnect) {
        window._playerReconnecting = true;
        showToast("🔄 Reconnecting...", "var(--accent)", "white", 2000);
        return;
      }

      if (mySlot === "SPECTATOR") {
        isSpectator = true;
        document.getElementById("spectatorBadge").classList.add("visible");
        document.getElementById("startMatchBtn").style.display  = "none";
        document.getElementById("readyBtn").style.display       = "none";
        window._spectatorAwaitingSync = true;
        showScreen("lobbyScreen");
        setTimeout(() => { window._spectatorAwaitingSync = false; }, 800);
      } else if (mySlot === "A") {
        document.getElementById("startMatchBtn").style.display = "block";
        document.getElementById("readyBtn").style.display      = "none";
        showScreen("lobbyScreen");
      } else if (mySlot === "B") {
        document.getElementById("startMatchBtn").style.display = "none";
        document.getElementById("readyBtn").style.display      = "block";
        showScreen("lobbyScreen");
      }
      return;
    }

    if (data.type === "ROOM_FULL") {
      if (data.payload?.canSpectate) {
        const overlay = document.createElement("div");
        overlay.className = "popupOverlay";
        overlay.style.cssText = "display:flex;z-index:99999;";
        overlay.innerHTML = `<div class="popupCard"><p class="popupEmoji">👁️</p><p style="font-family:var(--font-display);font-size:18px;font-weight:700;margin:0;">Room Full</p><p class="popupMsg">Spectate instead?</p><div class="btnRow" style="width:100%;"><button class="btnPrimary" id="rfYes">👁️ Spectate</button><button class="btnSecondary" id="rfNo">Back</button></div></div>`;
        document.body.appendChild(overlay);
        overlay.querySelector("#rfYes").onclick = () => {
          overlay.remove();
          if (socket) { socket.close(); socket = null; }
          const c = document.getElementById("joinRoomCodeInput").value.trim() || roomCode;
          roomCode = c; connectToServer(c, null, null, true, false);
        };
        overlay.querySelector("#rfNo").onclick = () => {
          overlay.remove(); switchTab("homeScreen","navHome");
          if (socket) { socket.close(); socket = null; }
        };
      } else { showAlert("Room is full!","🚫"); switchTab("homeScreen","navHome"); }
      return;
    }

    if (data.type === "SYNC_STATE") {
      const p = data.payload;

      // ── Always apply basic globals from sync payload ───────────────────
      matchMode      = p.mode;
      matchOvers     = p.overs;
      matchWickets   = p.wicketsLimit;
      currentInnings = p.currentInnings;
      // Cache permanent display names from sync payload
      if (p.displayNameA) window._displayNames.A = p.displayNameA;
      if (p.displayNameB) window._displayNames.B = p.displayNameB;
      document.getElementById("teamA").textContent = p.playerA || (p.displayNameA || "Empty");
      document.getElementById("teamB").textContent = p.playerB || (p.displayNameB || "Empty");

      // ── Player reconnect: route to correct screen, then return ─────────
      if (window._playerReconnecting) {
        window._playerReconnecting = false;
        _handlePlayerReconnectSync(p);
        return;
      }

      // ── Helper: apply full scoreboard from sync payload ────────────────
      // Writes all game-screen elements. Does NOT reset or clear anything.
      function _applySyncScoreboard(p) {
        if (p.displayNameA) window._displayNames.A = p.displayNameA;
        if (p.displayNameB) window._displayNames.B = p.displayNameB;
        currentBattingName = p.battingName || (p.battingTeam ? window._displayNames[p.battingTeam] : null);
        currentBowlingName = p.bowlingName || (p.battingTeam ? window._displayNames[p.battingTeam === "A" ? "B" : "A"] : null);
        // Respect _absentSlot: if a player is absent, show "Empty" for their role
        const _syncAbsent = window._absentSlot || null;
        const _syncAbsentName = _syncAbsent ? (window._displayNames[_syncAbsent] || null) : null;
        document.getElementById("battingName").textContent  = "Batsman: " + ((_syncAbsentName && currentBattingName === _syncAbsentName) ? "Empty" : currentBattingName);
        document.getElementById("bowlingName").textContent  = "Bowler: "  + ((_syncAbsentName && currentBowlingName === _syncAbsentName) ? "Empty" : currentBowlingName);
        document.getElementById("mainScore").textContent    =
          (p.battingTeam === "A" ? p.scoreA : p.scoreB) + " / " +
          (p.battingTeam === "A" ? p.wicketsA : p.wicketsB);
        document.getElementById("inningsDisplay").textContent = "Innings: " + p.currentInnings;
        document.getElementById("modeDisplay").textContent    =
          "Single • " + (p.mode === "limited" ? "Limited" : "Unlimited");
        const balls      = p.balls;
        const totalBalls = p.overs * 6;
        if (p.mode === "limited") {
          document.getElementById("overDisplay").textContent      = Math.floor(balls / 6) + "." + (balls % 6);
          document.getElementById("ballsLeftDisplay").textContent = totalBalls - balls;
        } else {
          document.getElementById("overDisplay").textContent      = "-";
          document.getElementById("ballsLeftDisplay").textContent = "-";
        }
        if (p.target) {
          const bs = p.battingTeam === "A" ? p.scoreA : p.scoreB;
          const rl = Math.max(p.target - bs, 0);
          const bl = totalBalls - balls;
          document.getElementById("targetDisplay").textContent   = p.target;
          document.getElementById("runsLeftDisplay").textContent = rl;
          document.getElementById("rrrDisplay").textContent      =
            (p.mode === "limited" && bl > 0) ? (rl / bl).toFixed(2) : "-";
        } else {
          document.getElementById("targetDisplay").textContent   = "-";
          document.getElementById("runsLeftDisplay").textContent = "-";
          document.getElementById("rrrDisplay").textContent      = "-";
        }
        document.getElementById("lockStatusBar").style.display = "flex";
        // Lock bar always uses _displayNames — never shows "Empty"
        document.getElementById("lockNameA").textContent       = window._displayNames.A || p.displayNameA || p.playerA || "Player A";
        document.getElementById("lockNameB").textContent       = window._displayNames.B || p.displayNameB || p.playerB || "Player B";
        document.getElementById("lockStatusA").classList.toggle("locked", p.lockedA);
        document.getElementById("lockStatusB").classList.toggle("locked", p.lockedB);
        document.getElementById("lockStateA").textContent = p.lockedA ? "Locked 🔒" : "Waiting ⏳";
        document.getElementById("lockStateB").textContent = p.lockedB ? "Locked 🔒" : "Waiting ⏳";
        // Ball history
        lastBalls = (p.ballHistory && p.ballHistory.length > 0) ? [...p.ballHistory] : [];
        syncedBallHistory = [...lastBalls];
        document.querySelectorAll(".ballBox").forEach((box, i) => {
          box.textContent = lastBalls[i] !== undefined ? lastBalls[i] : "-";
        });
        // Hide controls for spectator
        document.querySelector(".handContainer").style.display = "none";
        document.querySelector(".btnLock").style.display       = "none";
        document.querySelector(".controlLabel").style.display  = "none";
        document.querySelector(".selectedLabel").style.display = "none";
        document.getElementById("ballMessage").textContent     = "Watching the match...";
        // Populate preview screen fields too (used if we show preview first)
        document.getElementById("previewBattingName").textContent = p.battingName;
        document.getElementById("previewBowlingName").textContent = p.bowlingName;
        document.getElementById("previewMode").textContent        = p.mode === "limited" ? "Limited" : "Unlimited";
        document.getElementById("previewOvers").textContent       = p.mode === "limited" ? p.overs : "∞";
        document.getElementById("previewWickets").textContent     = p.wicketsLimit;
        updateDeclareBtn();
      }

      // ── Helper: replay buffered messages that arrived during sync wait ──
      // Call AFTER routing spectator to the correct screen.
      // Returns true if a terminal message (matchOver/inningsBreak) was found.
      function _replayBuffer() {
        const buf = [...spectatorSyncBuffer];
        spectatorSyncBuffer = [];
        for (const msg of buf) {
          // Dispatch as if it just arrived (skip the buffer guard)
          _dispatchSpectatorBuffered(msg);
        }
      }

      // ── 0. Not started yet → show lobby ────────────────────────────────
      if (!p.matchStarted) {
        window._spectatorAwaitingSync = false;
        spectatorSyncBuffer = [];
        showScreen("lobbyScreen");
        return;
      }

      // ── 1. Match already finished → build result screen from sync data ──
      if (p.matchStopped) {
        window._spectatorAwaitingSync = false;
        spectatorSyncBuffer = [];
        if (p.displayNameA) window._displayNames.A = p.displayNameA;
        if (p.displayNameB) window._displayNames.B = p.displayNameB;
        const dnA = p.displayNameA || p.playerA || "Player A";
        const dnB = p.displayNameB || p.playerB || "Player B";
        document.getElementById("teamA").textContent = dnA;
        document.getElementById("teamB").textContent = dnB;
        // Use stored lastResult if available (has ballsLeft, declared, etc.)
        if (p.lastResult) {
          // Ensure display names are set in lastResult
          const lr = Object.assign({}, p.lastResult, {
            displayNameA: dnA, displayNameB: dnB,
            usernameA: p.lastResult.usernameA || null,
            usernameB: p.lastResult.usernameB || null,
          });
          displayMatchResult(lr);
        } else {
          let winner;
          if (p.scoreA > p.scoreB)      winner = dnA;
          else if (p.scoreB > p.scoreA) winner = dnB;
          else                          winner = "Draw";
          displayMatchResult({
            winner,
            scoreA: p.scoreA, scoreB: p.scoreB,
            wicketsA: p.wicketsA, wicketsB: p.wicketsB,
            ballsLeft: null, declared: false,
            displayNameA: dnA, displayNameB: dnB,
            usernameA: null, usernameB: null,
          });
        }
        showScreen("resultScreen");
        return;
      }

      // ── 2. Match in toss/decision phase ────────────────────────────────
      if (!p.battingTeam) {
        // Sub-cases based on toss state
        if (p.tossFlipping) {
          // Coin is currently flipping (server set tossFlipping=true ~3s window)
          showScreen("tossScreen");
          document.getElementById("tossButtons").style.display = "none";
          document.getElementById("tossWaiting").style.display = "block";
          document.getElementById("coin").classList.remove("flip-heads", "flip-tails");
          isTossing = true;
          window._spectatorTossAnimating = true;
          animateCoinFlip(p.tossResult || "head");
          const winnerName = p.tossWinnerSlot === "A" ? p.playerA : p.playerB;
          // Store ref as _tossResultTimer so live MATCH_DECISION handler can cancel it
          window._tossResultTimer = setTimeout(() => {
            window._tossResultTimer = null;
            isTossing = false;
            // Guard: if a live MATCH_DECISION cancelled this animation
            // (_spectatorTossAnimating set to false), preview is already showing — bail out.
            if (!window._spectatorTossAnimating) return;
            window._spectatorTossAnimating = false;
            // Check if MATCH_DECISION arrived in the buffer while we were animating
            const bufferedDecision = spectatorSyncBuffer.find(m => m.type === "MATCH_DECISION");
            if (bufferedDecision) {
              spectatorSyncBuffer = spectatorSyncBuffer.filter(m => m.type !== "MATCH_DECISION");
              window._spectatorAwaitingSync = false;
              _applyMatchDecision(bufferedDecision.payload);
              showScreen("matchPreviewScreen");
              updateDeclareBtn();
              startPreviewCountdown();
            } else {
              // Players still deciding bat/bowl
              window._spectatorAwaitingSync = false;
              spectatorSyncBuffer = [];
              showScreen("decisionScreen");
              document.getElementById("decisionWaiting").textContent =
                "🪙 " + (p.tossResult || "head").toUpperCase() + " — " + winnerName + " won the toss!";
              document.getElementById("decisionButtons").style.display = "none";
              document.getElementById("decisionWaiting").style.display = "block";
            }
          }, 2500);
          return;
        }

        if (p.tossWinnerSlot) {
          // Toss done, animation window passed — check if bat/bowl also decided
          window._spectatorAwaitingSync = false;
          spectatorSyncBuffer = [];
          if (p.battingTeam) {
            // Already chose bat/bowl — go to preview
            _applyMatchDecision({
              batting: p.battingName, bowling: p.bowlingName,
              mode: p.mode, overs: p.overs, wicketsLimit: p.wicketsLimit,
            });
            showScreen("matchPreviewScreen");
            updateDeclareBtn();
            startPreviewCountdown();
          } else {
            // On decision screen
            const winnerName = p.tossWinnerSlot === "A" ? p.playerA : p.playerB;
            showScreen("decisionScreen");
            document.getElementById("decisionWaiting").textContent =
              "🪙 " + (p.tossResult ? p.tossResult.toUpperCase() + " — " : "") + winnerName + " won the toss!";
            document.getElementById("decisionButtons").style.display = "none";
            document.getElementById("decisionWaiting").style.display = "block";
          }
          return;
        }

        if (p.tossCaller) {
          // Player is selecting H/T
          window._spectatorAwaitingSync = false;
          spectatorSyncBuffer = [];
          showScreen("tossScreen");
          document.getElementById("tossButtons").style.display = "none";
          document.getElementById("tossWaiting").style.display = "block";
          document.getElementById("coin").classList.remove("flip-heads", "flip-tails");
          isTossing = false;
          const callerName = p.tossCaller === "A" ? p.playerA : p.playerB;
          document.getElementById("tossWaiting").textContent = "Waiting for " + callerName + "'s toss...";
          document.getElementById("tossMessage").textContent = callerName + " is tossing...";
          return;
        }

        // Waiting for START_MATCH
        window._spectatorAwaitingSync = false;
        spectatorSyncBuffer = [];
        showScreen("tossScreen");
        document.getElementById("tossButtons").style.display = "none";
        document.getElementById("tossWaiting").style.display = "block";
        document.getElementById("coin").classList.remove("flip-heads", "flip-tails");
        isTossing = false;
        document.getElementById("tossMessage").textContent = "Waiting for match to start...";
        return;
      }

      // ── 3. Match is running (battingTeam set) ──────────────────────────
      // Apply full scoreboard state first — this is the "mid-game bus stop" join
      _applySyncScoreboard(p);

      if (p.balls === 0 && p.currentInnings === 1) {
        // At start of innings 1 — players just chose bat/bowl, preview hasn't ended yet
        // Show preview screen then let countdown take us to game (no reset needed)
        window._spectatorAwaitingSync = false;
        window._spectatorSkipReset = true;  // prevent resetGameScreenForInnings from wiping synced data
        showScreen("matchPreviewScreen");
        updateDeclareBtn();
        startPreviewCountdown();
        // Replay any buffered balls that arrived after SYNC_STATE
        setTimeout(_replayBuffer, 0);
        return;
      }

      if (p.balls === 0 && p.currentInnings === 2) {
        // Just entered innings 2 — spectators always see matchPreviewScreen, not inningsBreakScreen
        currentInnings = 2;
        window._spectatorAwaitingSync = false;
        window._spectatorSkipReset = true;
        document.getElementById("previewBattingName").textContent = p.battingName;
        document.getElementById("previewBowlingName").textContent = p.bowlingName;
        document.getElementById("previewMode").textContent        = p.mode === "limited" ? "Limited" : "Unlimited";
        document.getElementById("previewOvers").textContent       = p.mode === "limited" ? p.overs : "∞";
        document.getElementById("previewWickets").textContent     = p.wicketsLimit;
        showScreen("matchPreviewScreen");
        updateDeclareBtn();
        startPreviewCountdown();
        setTimeout(_replayBuffer, 0);
        return;
      }

      // Mid-innings join (balls > 0) — show brief preview then jump straight to game
      window._spectatorAwaitingSync = false;
      window._spectatorSkipReset = true;  // startFromPreview must NOT reset the scoreboard
      showScreen("matchPreviewScreen");
      updateDeclareBtn();
      startPreviewCountdown();
      // Replay buffered balls after transition
      setTimeout(_replayBuffer, 0);
      return;
    }

    if (data.type === "LOBBY_UPDATE") {
      document.getElementById("lobbyRoomCode").textContent = roomCode;
      document.getElementById("teamA").textContent         = data.payload.teamA || "Waiting...";
      document.getElementById("teamB").textContent         = data.payload.teamB || "Waiting...";
      if (data.payload.spectatorCount !== undefined) {
        document.getElementById("spectatorCount").textContent     = data.payload.spectatorCount;
        document.getElementById("liveSpectatorCount").textContent = data.payload.spectatorCount;
      }
      // Cache real display names — only overwrite with non-empty values
      const skip = ["Waiting...", "Empty", "", null, undefined];
      if (!skip.includes(data.payload.teamA)) window._displayNames.A = data.payload.teamA;
      if (!skip.includes(data.payload.teamB)) window._displayNames.B = data.payload.teamB;
      // If both slots now have names, clear the empty-slot tracker
      if (data.payload.teamA && data.payload.teamB) window._hostTransferEmptySlot = null;
      return;
    }

    if (data.type === "HOST_TRANSFER") {
      isHost = true;
      document.getElementById("startMatchBtn").style.display = "block";
      document.getElementById("readyBtn").style.display      = "none";
      // Track the empty slot so startMatch() can show "wait for opponent" correctly
      window._hostTransferEmptySlot = data.payload.emptySlot || null;
      const leaverName = data.payload.leavingName || "Your opponent";
      document.getElementById("opponentLeftMsg").textContent = leaverName + " has left. You are now the host!";
      document.getElementById("opponentLeftPopup").style.display = "flex";
      return;
    }

    if (data.type === "HOST_STATUS") {
      if (isSpectator) return;
      const amHost = data.payload.hostSlot === mySlot;
      isHost = amHost;
      document.getElementById("startMatchBtn").style.display = amHost ? "block" : "none";
      document.getElementById("readyBtn").style.display      = amHost ? "none"  : "block";
      return;
    }

    if (data.type === "READY_UPDATE") {
      if (isHost) showToast("🏏 " + data.payload.nameB + " is ready! Start the match!", "var(--accent)");
      return;
    }

    if (data.type === "TOSS_CALLER") {
      if (isSpectator && window._spectatorAwaitingSync) { spectatorSyncBuffer.push(data); return; }
      showScreen("tossScreen");
          document.getElementById("coin").classList.remove("flip-heads","flip-tails");
      isTossing = false;
      const iAmCaller = data.payload.caller === mySlot;
      if (isSpectator) {
        const _callerName = data.payload.caller === "A" ? document.getElementById("teamA").textContent : document.getElementById("teamB").textContent;
        document.getElementById("tossButtons").style.display = "none";
        document.getElementById("tossWaiting").style.display = "block";
        document.getElementById("tossWaiting").textContent   = "Waiting for " + _callerName + "'s toss...";
        document.getElementById("tossMessage").textContent   = _callerName + " is tossing...";
      } else {
        const _oppName = data.payload.caller === mySlot ? "" : (data.payload.caller === "A" ? document.getElementById("teamA").textContent : document.getElementById("teamB").textContent);
        document.getElementById("tossButtons").style.display  = iAmCaller ? "flex" : "none";
        document.getElementById("tossWaiting").style.display  = iAmCaller ? "none" : "block";
        document.getElementById("tossWaiting").textContent    = iAmCaller ? "" : "Waiting for " + _oppName + "'s toss...";
        document.getElementById("tossMessage").textContent    = iAmCaller ? "Make your call!" : _oppName + " is tossing...";
      }
      return;
    }

    if (data.type === "TOSS_RESULT") {
      if (isSpectator && window._spectatorAwaitingSync) { spectatorSyncBuffer.push(data); return; }
      if (isSpectator) window._spectatorTossAnimating = true;
      animateCoinFlip(data.payload.coin);
      // Store timer so MATCH_DECISION can cancel it mid-flip
      window._tossResultTimer = setTimeout(() => {
        window._tossResultTimer = null;
        // Guard: if MATCH_DECISION already cancelled this (set _spectatorTossAnimating=false),
        // do nothing — preview screen is already showing.
        if (isSpectator && !window._spectatorTossAnimating) return;
        if (isSpectator) window._spectatorTossAnimating = false;
        const teamAName = document.getElementById("teamA").textContent;
        const teamBName = document.getElementById("teamB").textContent;
        showScreen("decisionScreen");
        document.getElementById("decisionWaiting").textContent = "🪙 "+data.payload.coin.toUpperCase()+" — "+data.payload.winner+" won the toss!";
        const amIWinner = (mySlot==="A"&&data.payload.winner===teamAName)||(mySlot==="B"&&data.payload.winner===teamBName);
        document.getElementById("decisionButtons").style.display = isSpectator ? "none" : (amIWinner ? "flex" : "none");
        document.getElementById("decisionWaiting").style.display = "block";
      }, 2500);
      return;
    }

    if (data.type === "MATCH_DECISION") {
      if (isSpectator && window._spectatorAwaitingSync) { spectatorSyncBuffer.push(data); return; }
      // If spectator coin flip is still animating, cancel it and go straight to preview
      if (isSpectator && window._spectatorTossAnimating) {
        if (window._tossResultTimer) { clearTimeout(window._tossResultTimer); window._tossResultTimer = null; }
        window._spectatorTossAnimating = false;
      }
      _applyMatchDecision(data.payload);
      showScreen("matchPreviewScreen"); updateDeclareBtn(); startPreviewCountdown();
      return;
    }

    if (data.type === "BALL_RESULT") {
      if (isSpectator && window._spectatorAwaitingSync) { spectatorSyncBuffer.push(data); return; }
      window.handLocked = false; selectedFingers = [];
      document.querySelectorAll(".handLayer").forEach(l => { if (!l.classList.contains("base")) l.classList.remove("open"); });
      document.getElementById("selectedDisplay").textContent = "None";

      const activeNow = document.querySelector(".screen.active")?.id;
      if (isSpectator && activeNow === "matchPreviewScreen") {
        const ballEntry = data.payload.out ? "W" : data.payload.lastRuns;
        if (syncedBallHistory.length >= 6) syncedBallHistory = [];
        syncedBallHistory.push(ballEntry);
        updateScoreboard(data.payload); updateDeclareBtn(); return;
      }

      updateScoreboard(data.payload); updateDeclareBtn();
      updateBallHistory(data.payload.balls, data.payload.out, data.payload.lastRuns);
      showBallMessage(data.payload.out, data.payload.lastRuns);
      if (isSpectator) {
        document.getElementById("lockStatusA").classList.remove("locked");
        document.getElementById("lockStatusB").classList.remove("locked");
        document.getElementById("lockStateA").textContent = "Waiting ⏳";
        document.getElementById("lockStateB").textContent = "Waiting ⏳";
      }
      if (data.payload.matchOver) {
        setTimeout(() => { displayMatchResult(data.payload); showScreen("resultScreen"); }, 900);
      }
      return;
    }

    if (data.type === "INNINGS_BREAK") {
      if (isSpectator && window._spectatorAwaitingSync) { spectatorSyncBuffer.push(data); return; }
      window.handLocked = false;
      const p = data.payload;
      currentBattingName = p.nextBattingName; currentBowlingName = p.nextBowlingName;
      // Use _displayNames fallback so disconnected player's name still shows
      const _wsBatterSlot = currentBattingName === (window._displayNames.A || "") ? "B" : "A";
      document.getElementById("breakBattedName").textContent  = p.nextBowlingName || window._displayNames[_wsBatterSlot] || "—";
      document.getElementById("breakScore1").textContent      = p.innings1Score + " / " + p.innings1Wickets;
      document.getElementById("breakTarget").textContent      = p.target;
      document.getElementById("breakBattingNext").textContent = p.nextBattingName || window._displayNames[_wsBatterSlot === "A" ? "B" : "A"] || "—";
      document.getElementById("breakModeInfo").textContent    = p.mode==="limited"
        ? "Needs "+p.target+" in "+(p.overs*6)+" balls"
        : "Needs "+p.target+" runs (no ball limit)";
      currentInnings = 2; updateDeclareBtn();
      setTimeout(() => { lastBalls = []; localBallCount = 0; showScreen("inningsBreakScreen"); startBreakCountdown(); }, 900);
      return;
    }

    if (data.type === "LOCK_STATUS") {
      if (!isSpectator) return;
      const { lockedA, lockedB, nameA, nameB } = data.payload;
      document.getElementById("lockStatusBar").style.display = "flex";
      // Always show the permanent display name — regardless of whether player is present
      // Lock bar always shows real display names — never "Empty"
      document.getElementById("lockNameA").textContent = window._displayNames.A || nameA || "Player A";
      document.getElementById("lockNameB").textContent = window._displayNames.B || nameB || "Player B";
      document.getElementById("lockStatusA").classList.toggle("locked", lockedA);
      document.getElementById("lockStatusB").classList.toggle("locked", lockedB);
      document.getElementById("lockStateA").textContent = lockedA ? "Locked 🔒" : "Waiting ⏳";
      document.getElementById("lockStateB").textContent = lockedB ? "Locked 🔒" : "Waiting ⏳";
      return;
    }

    if (data.type === "REMATCH_REQUEST") {
      if (isSpectator) { document.getElementById("rematchStatus").textContent = "⏳ "+data.payload.fromName+" wants a rematch..."; return; }
      if (data.payload.from === mySlot) return;
      document.getElementById("rematchBtn").style.display          = "none";
      document.getElementById("rematchStatus").textContent         = "🏏 "+data.payload.fromName+" wants a rematch!";
      document.getElementById("rematchReceiverBtns").style.display = "flex";
      return;
    }

    if (data.type === "REMATCH_DECLINED") {
      document.getElementById("rematchReceiverBtns").style.display = "none";
      if (isSpectator) {
        document.getElementById("rematchStatus").textContent = "❌ "+data.payload.fromName+" declined.";
        setTimeout(() => { document.getElementById("rematchStatus").textContent = "Waiting to see if players rematch..."; }, 500);
        return;
      }
      document.getElementById("rematchStatus").textContent = data.payload.fromName === playerName ? "❌ You declined." : "❌ "+data.payload.fromName+" declined.";
      setTimeout(() => {
        document.getElementById("rematchBtn").style.display  = "block";
        document.getElementById("rematchBtn").disabled       = false;
        document.getElementById("rematchBtn").textContent    = "🔄 Request Rematch";
        document.getElementById("rematchStatus").textContent = "";
      }, 500);
      return;
    }

    if (data.type === "REMATCH_START") {
      // For spectators: keep _spectatorAwaitingSync=true so TOSS_CALLER and other
      // live messages are buffered while spectator reads the choice screen.
      // watchRematch() will send SYNC_REQUEST which re-routes correctly.
      // For players: clear buffer and proceed to toss.
      if (!isSpectator) {
        spectatorSyncBuffer = [];
        window._spectatorAwaitingSync = false;
      }
      document.getElementById("spectatorRematchChoice")?.remove();
      if (isSpectator) {
        // Buffer live messages until spectator decides (watchRematch sets _spectatorAwaitingSync=true,
        // which is already true here — just clear any stale buffer from last match)
        spectatorSyncBuffer = [];
        window._spectatorAwaitingSync = true;
        // Cancel any pending countdowns that might re-route us away
        if (previewCountdownTimer) { clearInterval(previewCountdownTimer); previewCountdownTimer = null; }
        if (breakCountdownTimer)   { clearInterval(breakCountdownTimer);   breakCountdownTimer   = null; }
        // Force to resultScreen so the choice UI has a place to land
        showScreen("resultScreen");
        // Reset result card to a clean "Rematch Starting" state
        document.getElementById("resultEmoji").textContent      = "👁️";
        document.getElementById("resultTitle").textContent      = "Rematch Starting!";
        document.getElementById("matchSummary").style.display   = "none";
        document.getElementById("matchStats").style.display     = "none";
        document.getElementById("rematchSection").style.display = "none";
        document.getElementById("exitMatchBtn").style.display   = "none";
        document.getElementById("friendSection").style.display  = "none";
        const choice = document.createElement("div");
        choice.id = "spectatorRematchChoice";
        choice.style.cssText = "display:flex;flex-direction:column;gap:10px;width:100%";
        choice.innerHTML = `<p style="font-size:14px;color:var(--text-muted);margin:0;text-align:center;">Players are starting a rematch.</p><button class="btnPrimary fullWidth" onclick="watchRematch()">👁️ Watch Again</button><button class="btnSecondary fullWidth" onclick="exitMatch()">← Back to Menu</button>`;
        document.querySelector("#resultScreen .centerCard").appendChild(choice);
        return;
      }
      isTossing = false; lastBalls = []; localBallCount = 0; selectedFingers = [];
      window.handLocked = false;
      window._absentSlot = null; // reset absent tracker for new match
      document.getElementById("coin").classList.remove("flip-heads","flip-tails");
      showScreen("tossScreen");
      return;
    }

    if (data.type === "OPPONENT_LEFT") {
      const leaverName = data.payload.name || "Your opponent";
      const canRejoin  = data.payload.canRejoin || false;
      const leaverSlot = data.payload.slot || null; // server now always sends slot
      const teamAEl = document.getElementById("teamA");
      const teamBEl = document.getElementById("teamB");
      // Use server-provided slot first; fall back to display name matching
      const leaverIsA = leaverSlot
        ? leaverSlot === "A"
        : (window._displayNames.A === leaverName || teamAEl.textContent === leaverName);
      // Mark absent slot so updateScoreboard keeps showing "Empty" on every ball result
      window._absentSlot = leaverIsA ? "A" : "B";
      if (leaverIsA) {
        teamAEl.textContent = "Empty";
      } else {
        teamBEl.textContent = "Empty";
      }
      // Scoreboard: immediately show "Empty" for the leaver's batting/bowling role
      const _leaverDN = window._displayNames[window._absentSlot] || leaverName;
      const _battingEl = document.getElementById("battingName");
      const _bowlingEl = document.getElementById("bowlingName");
      if (_battingEl && currentBattingName === _leaverDN) {
        _battingEl.textContent = "Batsman: Empty";
      }
      if (_bowlingEl && currentBowlingName === _leaverDN) {
        _bowlingEl.textContent = "Bowler: Empty";
      }
      // NOTE: lock bar names are NEVER changed here — they always show real names
      if (!isSpectator) {
        const activeScreen = document.querySelector(".screen.active");
        if (activeScreen && activeScreen.id === "resultScreen") {
          showToast("🚪 " + leaverName + " has left", "var(--surface2)", "var(--text)", 2500);
        } else {
          document.getElementById("opponentLeftMsg").textContent = canRejoin
            ? leaverName + " disconnected. Waiting for them to reconnect..."
            : leaverName + " has left.";
          document.getElementById("opponentLeftPopup").style.display = "flex";
        }
      }
      return;
    }

    if (data.type === "BOTH_LEFT") {
      if (!isSpectator) return;
      const overlay = document.createElement("div");
      overlay.className = "popupOverlay";
      overlay.style.cssText = "display:flex;z-index:99999;";
      overlay.innerHTML = `<div class="popupCard"><p class="popupEmoji">🚪</p><p style="font-family:var(--font-display);font-size:18px;font-weight:700;margin:0;">Match Ended</p><p class="popupMsg">Both players have left.</p><button class="btnPrimary fullWidth" onclick="confirmLeave()">← Back to Menu</button></div>`;
      document.body.appendChild(overlay);
      return;
    }

    // Incoming friend request — opponent clicked "Add Friend"
    if (data.type === "FRIEND_REQUEST_RECEIVED") {
      const fs = document.getElementById("friendSection");
      if (!fs || fs.style.display === "none") return;
      // Store their username so acceptFriend/declineFriend know who to respond to
      window._resultOppUsername    = data.payload.fromUsername;
      window._resultOppDisplayName = data.payload.fromDisplayName;
      document.getElementById("friendAddBtn").style.display       = "none";
      document.getElementById("friendStatus").textContent         = "👥 " + data.payload.fromDisplayName + " wants to be friends!";
      document.getElementById("friendReceiverBtns").style.display = "flex";
      return;
    }

    // Friend respond result
    if (data.type === "FRIEND_RESPOND_RESULT") {
      const { action, fromDisplayName, toDisplayName } = data.payload;
      // fromDisplayName = the one who accepted/declined (the receiver of the original request)
      // toDisplayName   = the one who originally sent the request
      // Each player uses _resultOppDisplayName which is already set correctly for them
      const oppName = window._resultOppDisplayName || fromDisplayName || toDisplayName;
      if (action === "accept") {
        document.getElementById("friendReceiverBtns").style.display = "none";
        document.getElementById("friendAddBtn").style.display        = "none";
        document.getElementById("friendStatus").textContent          = "✅ You and " + oppName + " are now friends!";
      } else {
        // Declined — reset to Add button (loop)
        document.getElementById("friendReceiverBtns").style.display = "none";
        document.getElementById("friendStatus").textContent          = "❌ " + oppName + " declined.";
        setTimeout(() => {
          document.getElementById("friendAddBtn").textContent   = "👥 Add " + oppName + " as Friend";
          document.getElementById("friendAddBtn").disabled      = false;
          document.getElementById("friendAddBtn").style.display = "block";
          document.getElementById("friendStatus").textContent   = "";
        }, 600);
      }
      return;
    }

  }; // end onmessage
} // end connectToServer

// ══════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════
function showToast(msg, bg = "var(--accent)", color = "white", duration = 1000) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:${color};padding:12px 24px;border-radius:10px;font-weight:700;font-size:15px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3);text-align:center;max-width:300px;`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

function showAlert(msg, emoji = "ℹ️", onOk = null) {
  const overlay = document.createElement("div");
  overlay.className = "popupOverlay";
  overlay.style.cssText = "display:flex;z-index:99999;";
  overlay.innerHTML = `<div class="popupCard"><p class="popupEmoji">${emoji}</p><p class="popupMsg" style="color:var(--text);font-size:15px;font-weight:600;">${msg}</p><button class="btnPrimary fullWidth" id="alertOkBtn">OK</button></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#alertOkBtn").onclick = () => { overlay.remove(); if (onOk) onOk(); };
}

// ══════════════════════════════════════════════
// SETTINGS UI
// ══════════════════════════════════════════════
function loadSettingsUI() {
  // Fix #1: always start on controls tab when opening settings
  switchSettingsTab("controls");
  document.getElementById("kbToggleTrack").classList.toggle("on",    keyboardEnabled);
  document.getElementById("mouseToggleTrack").classList.toggle("on", mouseEnabled);
  document.getElementById("sfxToggleTrack").classList.toggle("on",   sfxEnabled);
  document.getElementById("sfxVolumeSlider").value     = sfxVolume;
  document.getElementById("sfxVolumeVal").textContent  = sfxVolume;
  document.getElementById("bgmToggleTrack").classList.toggle("on",   bgmEnabled);
  document.getElementById("bgmVolumeSlider").value     = bgmVolume;
  document.getElementById("bgmVolumeVal").textContent  = bgmVolume;
  renderKeybindList();
}

function switchSettingsTab(tab) {
  // Fix #1: explicitly hide/show — never inherit from previous state
  ["controls","audio"].forEach(t => {
    document.getElementById("sTab-"+t).classList.toggle("active", t===tab);
    document.getElementById("settingsPane-"+t).style.display = t===tab ? "flex" : "none";
  });
}

function openSettingsPopup() {
  syncSettingsPopupUI();
  // Fix #1: always start on controls tab, ensure audio pane is hidden
  document.getElementById("settingsPopupPane-audio").style.display = "none";
  document.getElementById("settingsPopupPane-controls").style.display = "flex";
  document.getElementById("spTab-controls").classList.add("active");
  document.getElementById("spTab-audio").classList.remove("active");
  document.getElementById("settingsPopup").style.display = "flex";
}

function switchSettingsPopupTab(tab) {
  ["controls","audio"].forEach(t => {
    document.getElementById("spTab-"+t).classList.toggle("active", t===tab);
    document.getElementById("settingsPopupPane-"+t).style.display = t===tab ? "flex" : "none";
  });
}

function syncSettingsPopupUI() {
  const sp = (id, cls) => { const el = document.getElementById(id); if(el) el.classList.toggle("on", cls); };
  sp("spKbToggleTrack",    keyboardEnabled);
  sp("spMouseToggleTrack", mouseEnabled);
  sp("spSfxToggleTrack",   sfxEnabled);
  sp("spBgmToggleTrack",   bgmEnabled);
  const sv = document.getElementById("spSfxVolumeSlider");
  const bv = document.getElementById("spBgmVolumeSlider");
  if (sv) { sv.value = sfxVolume; document.getElementById("spSfxVolumeVal").textContent = sfxVolume; }
  if (bv) { bv.value = bgmVolume; document.getElementById("spBgmVolumeVal").textContent = bgmVolume; }
}

function toggleKeyboard() {
  keyboardEnabled = !keyboardEnabled;
  document.getElementById("kbToggleTrack").classList.toggle("on", keyboardEnabled);
  saveSettings();
  showToast(keyboardEnabled ? "⌨️ Keyboard enabled" : "⌨️ Keyboard disabled", "var(--accent)");
}

function toggleMouse() {
  mouseEnabled = !mouseEnabled;
  document.getElementById("mouseToggleTrack").classList.toggle("on", mouseEnabled);
  const hand    = document.querySelector(".handContainer");
  const lockBtn = document.querySelector(".btnLock");
  if (hand)    hand.style.pointerEvents    = mouseEnabled ? "auto" : "none";
  if (lockBtn) lockBtn.style.pointerEvents = mouseEnabled ? "auto" : "none";
  saveSettings();
  showToast(mouseEnabled ? "🖱️ Mouse enabled" : "🖱️ Mouse disabled", "var(--accent)");
}

function toggleSFX() {
  sfxEnabled = !sfxEnabled;
  document.getElementById("sfxToggleTrack").classList.toggle("on", sfxEnabled);
  saveSettings();
}

function setSFXVolume(val) {
  sfxVolume = parseInt(val);
  document.getElementById("sfxVolumeVal").textContent = sfxVolume;
  Object.values(sounds).forEach(a => { a.volume = sfxEnabled ? sfxVolume/100 : 0; });
  saveSettings();
}

// ── Keybinds ──────────────────────────────────────────────────────────────────
function renderKeybindList() {
  const list = document.getElementById("keybindList");
  if (!list) return;
  list.innerHTML = "";
  const codeCounts = {};
  for (const code of Object.values(keybinds)) codeCounts[code] = (codeCounts[code]||0)+1;
  // Only render keys that have a label — hidden keys (nav_home etc.) are excluded
  for (const action of Object.keys(KEYBIND_LABELS)) {
    const code = keybinds[action];
    if (!code) continue;
    const isRisky     = RISKY_KEYBINDS.has(action);
    const isDuplicate = codeCounts[code] > 1;
    const row = document.createElement("div");
    row.className = "keybindRow";
    row.innerHTML = `
      <span class="keybindName">
        ${KEYBIND_LABELS[action]}
        ${isRisky ? `<button class="keybindWarningBtn" onclick="showKeybindWarning('${action}')" title="Risky">⚠️</button>` : ""}
      </span>
      <button class="keybindKey${isDuplicate?" conflict":""}" id="kb-${action}" onclick="startListening('${action}')">${codeToLabel(code)}</button>`;
    list.appendChild(row);
  }
}

function showKeybindWarning(action) { showAlert(RISKY_REASONS[action]||"Risky keybind.","⚠️"); }

function codeToLabel(code) {
  if (!code) return "—";
  if (code.startsWith("Digit")) return code.replace("Digit","");
  if (code.startsWith("Key"))   return code.replace("Key","");
  const map = {
    Space:"SPC", Enter:"ENT", Escape:"ESC", Backspace:"Back",
    Delete:"Del", End:"End", Home:"Home", Tab:"Tab",
    ShiftLeft:"Shft", ShiftRight:"Shft", AltLeft:"Alt",
    AltRight:"Alt", ControlLeft:"Ctrl", ControlRight:"Ctrl",
    ArrowUp:"↑", ArrowDown:"↓", ArrowLeft:"←", ArrowRight:"→",
  };
  if (map[code]) return map[code];
  if (code.startsWith("F") && !isNaN(code.slice(1))) return code;
  return code.slice(0,5);
}

let listeningAction = null;
let listeningKeyEl  = null;

function startListening(action) {
  stopListening();
  listeningAction = action;
  listeningKeyEl  = document.getElementById("kb-"+action);
  if (listeningKeyEl) listeningKeyEl.classList.add("listening");
  document.getElementById("keybindTarget").textContent = KEYBIND_LABELS[action]||action;
  document.getElementById("keybindCapture").style.display = "flex";
  document.addEventListener("keydown", captureKey, { once:true });
}

function stopListening() {
  if (listeningKeyEl) listeningKeyEl.classList.remove("listening");
  listeningAction = null; listeningKeyEl = null;
  document.getElementById("keybindCapture").style.display = "none";
  document.removeEventListener("keydown", captureKey);
}

function captureKey(e) {
  e.preventDefault();
  document.getElementById("keybindCapture").style.display = "none";
  if (e.code === "Escape") { stopListening(); return; }
  if (listeningAction) { keybinds[listeningAction] = e.code; saveSettings(); renderKeybindList(); }
  listeningAction = null; listeningKeyEl = null;
}

function resetKeybinds() {
  keybinds = { ...DEFAULT_KEYBINDS }; saveSettings(); renderKeybindList();
  showToast("✅ Keybinds reset", "var(--green)", "#0f172a");
}

function getTopPopup() {
  const all = [...document.querySelectorAll(".popupOverlay")].filter(
    el => el.id !== "keybindCapture" && el.style.display !== "none"
  );
  return all.length ? all[all.length-1] : null;
}

// ══════════════════════════════════════════════
// GLOBAL KEYBOARD HANDLER
// ══════════════════════════════════════════════
document.addEventListener("keydown", (e) => {
  const key = e.code;

  // ── Keybind capture overlay — always intercept ───────────────────────────
  if (document.getElementById("keybindCapture").style.display !== "none") {
    if (key === "Escape") { e.preventDefault(); stopListening(); }
    return;
  }

  // ── Keyboard OFF — stop everything ───────────────────────────────────────
  if (!keyboardEnabled) return;

  // ── Skip if typing in a text input (let initInputChaining handle those) ───
  const tag = document.activeElement?.tagName;
  const isInInput = (tag === "INPUT" || tag === "TEXTAREA") &&
    document.activeElement?.type !== "range";

  // ── Popup layer ───────────────────────────────────────────────────────────
  const topPopup = getTopPopup();
  if (topPopup) {
    if (!isInInput && (key === keybinds.confirm || key === "Enter")) {
      e.preventDefault();
      const primary = topPopup.querySelector(".btnPrimary");
      if (primary) primary.click();
    }
    if (!isInInput && (key === keybinds.back_cancel || key === "Escape")) {
      e.preventDefault();
      const allSec = topPopup.querySelectorAll(".btnSecondary");
      const cancel = allSec[allSec.length - 1];
      if (cancel) cancel.click();
    }
    if (!isInInput && topPopup.id === "inMatchLeavePopup" && key === keybinds.declare) {
      e.preventDefault(); showDeclareFromMenu();
    }
    return;
  }

  const active = document.querySelector(".screen.active");
  if (!active) return;
  const screenId = active.id;

  if (isInInput) return;  // all further handlers are non-input

  // ── In-game settings (F1) ─────────────────────────────────────────────────
  if (key === keybinds.settings || key === "F1") {
    if (screenId === "gameScreen") { e.preventDefault(); openSettingsPopup(); }
    return;
  }

  // ── Theme toggle ──────────────────────────────────────────────────────────
  if (key === keybinds.theme) {
    // Don't fire on own profile (Backspace there = logout if same key)
    const isOwnProfile = screenId === "profileScreen" &&
      (!window._viewingProfile || window._viewingProfile === authUsername);
    if (!isOwnProfile) { e.preventDefault(); toggleTheme(); return; }
  }

  // ── Profile screen shortcuts ──────────────────────────────────────────────
  if (screenId === "profileScreen") {
    const isOwnProfile   = !window._viewingProfile || window._viewingProfile === authUsername;
    const isOtherProfile = window._viewingProfile && window._viewingProfile !== authUsername;

    if (isOwnProfile) {
      if (key === keybinds.profile_delete) { e.preventDefault(); openDeleteAccount(); return; }
      if (key === keybinds.profile_logout) { e.preventDefault(); doLogout(); return; }
    }

    if (isOtherProfile) {
      const addBtn     = document.getElementById("addFriendProfileBtn");
      const declineBtn = document.getElementById("declineFriendProfileBtn");
      const hasPending = declineBtn && declineBtn.style.display !== "none";
      if (key === keybinds.confirm || key === "Enter") {
        if (addBtn && addBtn.style.display !== "none" && !addBtn.disabled) {
          e.preventDefault(); addBtn.click(); return;
        }
      }
      if (key === keybinds.back_cancel || key === "Escape") {
        if (hasPending) { e.preventDefault(); declineBtn.click(); return; }
        e.preventDefault(); handleBack(); return;
      }
    }
  }

  // ── Settings screen: reset keybinds ──────────────────────────────────────
  if (screenId === "settingsScreen") {
    if (key === keybinds.settings_reset) { e.preventDefault(); resetKeybinds(); return; }
  }

  // ── Declare ───────────────────────────────────────────────────────────────
  if (key === keybinds.declare) {
    const btn = document.getElementById("gameDeclareBtn");
    if (btn && btn.style.display !== "none") { e.preventDefault(); declareMatch(); return; }
    // Also in inMatchLeavePopup handled above via topPopup
  }

  // ── Back / Cancel ─────────────────────────────────────────────────────────
  if (key === keybinds.back_cancel || key === "Escape") {
    e.preventDefault();
    if (screenId === "resultScreen") {
      const rb = document.getElementById("rematchReceiverBtns");
      if (rb && rb.style.display !== "none") declineRematch();
      else exitMatch();
      return;
    }
    const backBtn = document.getElementById("globalBackBtn");
    if (backBtn && backBtn.style.display !== "none") handleBack();
    return;
  }

  // ── Confirm / Enter — screen-specific ────────────────────────────────────
  if (key === keybinds.confirm || key === "Enter") {
    e.preventDefault();
    if (screenId === "homeScreen") {
      const code = document.getElementById("joinRoomCodeInput").value.trim();
      if (code) {
        const specKey  = keybinds.spectate;
        const specHeld = (specKey === "ShiftLeft"    && e.shiftKey)
                      || (specKey === "ShiftRight"   && e.shiftKey)
                      || (specKey === "AltLeft"      && e.altKey)
                      || (specKey === "AltRight"     && e.altKey)
                      || (specKey === "ControlLeft"  && e.ctrlKey)
                      || (specKey === "ControlRight" && e.ctrlKey);
        if (specHeld) spectateRoom(); else joinRoom();
      }
      return;
    }
    if (screenId === "roomSetupScreen")    { createRoom(); return; }
    if (screenId === "lobbyScreen")        { if (!isSpectator&&isHost) startMatch(); else if (!isSpectator&&!isHost) sendReady(); return; }
    if (screenId === "matchPreviewScreen") { skipPreview(); return; }
    if (screenId === "inningsBreakScreen") { skipBreak(); return; }
    if (screenId === "resultScreen") {
      const sc = document.getElementById("spectatorRematchChoice");
      if (sc) { const wb = sc.querySelector(".btnPrimary"); if(wb) wb.click(); return; }
      const rb = document.getElementById("rematchReceiverBtns");
      if (rb && rb.style.display !== "none") acceptRematch();
      else { const rm = document.getElementById("rematchBtn"); if(rm&&rm.style.display!=="none") requestRematch(); }
      return;
    }
    if (screenId === "decisionScreen") {
      const btns = document.getElementById("decisionButtons");
      if (btns && btns.style.display !== "none") sendDecision("bat");
      return;
    }
    return;
  }

  // ── Below: also gated by listeningAction ─────────────────────────────────
  if (listeningAction) return;

  // ── Nav cycle (single key, cycles through tabs) ───────────────────────────
  if (key === keybinds.nav_cycle && TAB_SCREENS.includes(screenId)) {
    e.preventDefault();
    const order  = ["homeScreen","friendsScreen","leaderboardScreen","profileScreen","settingsScreen"];
    const navIds = { homeScreen:"navHome", friendsScreen:"navFriends", leaderboardScreen:"navLeaderboard", profileScreen:"navProfile", settingsScreen:"navSettings" };
    const next   = order[(order.indexOf(screenId) + 1) % order.length];
    switchTab(next, navIds[next]);
    if (next === "friendsScreen")     loadFriends();
    if (next === "leaderboardScreen") loadLeaderboard();
    if (next === "profileScreen")     openOwnProfile();
    return;
  }

  // ── Decision screen bat/bowl ──────────────────────────────────────────────
  if (screenId === "decisionScreen") {
    if (key === keybinds.bat  && key !== keybinds.confirm) { e.preventDefault(); sendDecision("bat");  return; }
    if (key === keybinds.bowl && key !== keybinds.confirm) { e.preventDefault(); sendDecision("bowl"); return; }
  }

  // ── Toss screen ───────────────────────────────────────────────────────────
  if (screenId === "tossScreen") {
    const btns = document.getElementById("tossButtons");
    if (btns && btns.style.display !== "none") {
      if (key === keybinds.toss_heads) { e.preventDefault(); sendToss("head"); }
      if (key === keybinds.toss_tails) { e.preventDefault(); sendToss("tail"); }
      if (key === keybinds.toss_pass)  { e.preventDefault(); sendToss("pass"); }
    }
    return;
  }

  // ── Game screen — fingers + lock ──────────────────────────────────────────
  if (screenId === "gameScreen" && !isSpectator && !window.handLocked) {
    const fingerMap = {
      [keybinds.thumb]:"thumb", [keybinds.index]:"index", [keybinds.middle]:"middle",
      [keybinds.ring]:"ring",   [keybinds.pinky]:"pinky",
    };
    if (fingerMap[key]) { e.preventDefault(); toggleHandFinger(fingerMap[key]); }
    if (key === keybinds.lock) { e.preventDefault(); lockHand(); }
  }
});
// ══════════════════════════════════════════════
// INTRO ANIMATION
// ══════════════════════════════════════════════
function runIntroAnimation(onComplete) {
  const screen    = document.getElementById("introScreen");
  const canvas    = document.getElementById("intro-particle-canvas");
  const ctx       = canvas.getContext("2d");
  const glow      = document.getElementById("intro-ambient-glow");
  const ringSvg   = document.getElementById("intro-ring-svg");
  const ringMain  = document.getElementById("intro-ring-main");
  const ringDsh   = document.getElementById("intro-ring-dashed");
  const logoWrap  = document.getElementById("intro-logo-wrapper");
  const logoImg   = document.getElementById("intro-logo-img");
  const streak    = document.getElementById("intro-streak");
  const shakeEl   = document.getElementById("intro-shake-wrapper");

  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  const onResize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  window.addEventListener("resize", onResize);

  try { navigator.vibrate && navigator.vibrate(50); } catch(_) {}

  let phase = 0, particles = [], rafId = null, done = false;

  function spawnParticles() {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3;
      particles.push({
        x: cx + Math.cos(a) * 170, y: cy + Math.sin(a) * 170,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, maxLife: 30 + Math.random() * 30, size: Math.random() * 2.5 + 0.5,
      });
    }
  }

  function renderParticles() {
    if (done) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (phase >= 1 && phase < 4 && Math.random() > 0.4) spawnParticles();
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; p.x += p.vx; p.y += p.vy; p.life++;
      if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
      const alpha = 1 - p.life / p.maxLife;
      ctx.shadowBlur = 10; ctx.shadowColor = "#00ffff";
      ctx.fillStyle = "rgba(0,255,255," + alpha + ")";
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    rafId = requestAnimationFrame(renderParticles);
  }

  rafId = requestAnimationFrame(renderParticles);
  glow.classList.add("active");

  setTimeout(() => {
    phase = 1;
    ringMain.classList.add("draw");
    ringDsh.classList.add("show");
    ringSvg.classList.add("spin");
  }, 500);

  setTimeout(() => {
    phase = 2;
    logoWrap.classList.add("appear");
    shakeEl.classList.add("shake");
    try { navigator.vibrate && navigator.vibrate([50, 50, 100]); } catch(_) {}
    setTimeout(() => shakeEl.classList.remove("shake"), 450);
  }, 1500);

  setTimeout(() => { phase = 3; streak.classList.add("fire"); }, 2200);

  setTimeout(() => {
    phase = 4; done = true;
    // Freeze ring at current rotation
    const cs = window.getComputedStyle(ringSvg);
    const m  = new DOMMatrix(cs.transform);
    const angle = Math.atan2(m.b, m.a) * (180 / Math.PI);
    ringSvg.style.transform = "rotate(" + angle + "deg)";
    ringSvg.style.animation = "none";
    // Stop particles
    if (rafId) cancelAnimationFrame(rafId);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Final glow
    logoImg.classList.add("final-glow");
    glow.style.opacity = "0.4";
  }, 2800);

  // After animation finishes, fade out and call onComplete
  setTimeout(() => {
    window.removeEventListener("resize", onResize);
    screen.classList.add("fade-out");
    setTimeout(() => {
      screen.style.display = "none";
      onComplete();
    }, 600); // matches CSS transition duration
  }, 3600);
}

// ══════════════════════════════════════════════
// MODE DISPLAY — click to show room code
// ══════════════════════════════════════════════
let _modeDisplayTimer = null;

function initModeDisplay() {
  const el = document.getElementById("modeDisplay");
  if (!el) return;
  el.style.cursor = "pointer";
  el.title = "Click to copy room code";
  el.addEventListener("click", () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode).catch(() => {});
    const prev = el.textContent;
    el.textContent = roomCode;
    el.style.color = "var(--accent2)";
    if (_modeDisplayTimer) clearTimeout(_modeDisplayTimer);
    _modeDisplayTimer = setTimeout(() => {
      el.textContent = "Single • " + (matchMode === "limited" ? "Limited" : "Unlimited");
      el.style.color = "";
      _modeDisplayTimer = null;
    }, 2500);
  });
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
loadSettings();
initInputChaining();
initModeDisplay();
document.addEventListener("click",   initBGM, { once: true });
document.addEventListener("keydown", initBGM, { once: true });

// Run intro first, then check login
runIntroAnimation(() => {
  checkAutoLogin();
});
