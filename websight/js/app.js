import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, onValue, update, query, limitToLast }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app), db = getDatabase(app);
const $ = id => document.getElementById(id);
const fmt = ts => ts ? new Date(ts * 1000).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" }) : "--";
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
const fillIfEmpty = (id, val) => { const el = $(id); if (el && !el.value) el.value = val; };

let control = {}, status = {}, sensors = {};

// ---------- Money Plant profile ----------
const PLANT = {
  soil: { idealLow: 40, idealHigh: 70, alertHigh: 85 },     // alert-low = Settings "Low moisture alert %"
  temp: { alertLow: 15, idealLow: 18, idealHigh: 30, alertHigh: 32 },
  hum:  { alertLow: 35, idealLow: 40, idealHigh: 60, alertHigh: 75 }
};

function judge(v, aLo, iLo, iHi, aHi) {
  if (v < aLo) return "low-alert";
  if (v < iLo) return "low-warn";
  if (v <= iHi) return "ideal";
  if (v <= aHi) return "high-warn";
  return "high-alert";
}

const TEXT = {
  soil: {
    "low-alert":  ["Too dry", "bad", "Water your Money Plant now. The soil is too dry and the leaves may droop or turn yellow."],
    "low-warn":   ["Getting dry", "warn", "Soil is getting dry. Water soon if the top 2–3 cm feels dry."],
    "ideal":      ["Ideal", "on", "Soil moisture is perfect. No watering needed."],
    "high-warn":  ["Quite moist", "warn", "Soil is quite moist. Do not water until the top layer dries a little."],
    "high-alert": ["Too wet", "bad", "Soil is too wet. Stop watering, make sure the pot drains, and let it dry. Too much water causes root rot."]
  },
  temp: {
    "low-alert":  ["Too cold", "bad", "Too cold for a Money Plant. Move it away from cold windows, AC and drafts."],
    "low-warn":   ["Cool", "warn", "A bit cool. Money Plants grow best between 18 and 30 °C."],
    "ideal":      ["Ideal", "on", "Temperature is ideal for growth."],
    "high-warn":  ["Warm", "warn", "Getting warm. Keep the plant out of direct sunlight."],
    "high-alert": ["Too hot", "bad", "Too hot. Move the plant away from direct sun and heat, and water if the soil is dry."]
  },
  hum: {
    "low-alert":  ["Too dry air", "bad", "Air is too dry. Mist the leaves, or place a tray of water near the plant."],
    "low-warn":   ["Slightly dry", "warn", "Air is slightly dry. Misting the leaves now and then helps."],
    "ideal":      ["Ideal", "on", "Humidity is ideal."],
    "high-warn":  ["Humid", "warn", "Quite humid. Make sure the room has some airflow."],
    "high-alert": ["Too humid", "bad", "Too humid. Improve ventilation to avoid fungus and leaf spots."]
  }
};

const ALERT_MSG = {
  soil: { "low-alert": "Soil is too dry", "high-alert": "Soil is too wet" },
  temp: { "low-alert": "Temperature is too low", "high-alert": "Temperature is too high" },
  hum:  { "low-alert": "Humidity is too low", "high-alert": "Humidity is too high" }
};

const popped = new Set();
function popup(key, title, body) {
  if (popped.has(key)) return;
  popped.add(key);
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

function careRow(kind, badgeId, tipId, value, unit, aLo, iLo, iHi, aHi, available, alerts) {
  const badge = $(badgeId);
  if (!available) {
    if (badge) { badge.textContent = "No data"; badge.className = "badge"; }
    setText(tipId, "No live data. Check that the ESP32 and sensor are working.");
    popped.forEach(k => { if (k.startsWith(kind + ":")) popped.delete(k); });
    return;
  }
  const state = judge(value, aLo, iLo, iHi, aHi);
  const [label, cls, tip] = TEXT[kind][state];
  if (badge) { badge.textContent = label + " (" + value + unit + ")"; badge.className = "badge " + (cls === "bad" ? "off" : cls); }
  setText(tipId, tip);
  const key = kind + ":" + state;
  if (state === "low-alert" || state === "high-alert") {
    alerts.push(ALERT_MSG[kind][state] + " (" + value + unit + ")");
    popup(key, "🌱 " + ALERT_MSG[kind][state], tip);
  } else {
    popped.forEach(k => { if (k.startsWith(kind + ":")) popped.delete(k); });
  }
}

// ---------- login / logout ----------
$("btnLogin").onclick = async () => {
  try { await signInWithEmailAndPassword(auth, $("email").value, $("password").value); }
  catch (e) { $("loginErr").textContent = e.message; }
};
$("btnLogout").onclick = () => signOut(auth);
onAuthStateChanged(auth, user => {
  $("login").hidden = !!user;
  $("app").hidden = !user;
  if (user) startListeners();
});

// ---------- navigation ----------
document.querySelectorAll("#nav a").forEach(a => a.onclick = () => {
  document.querySelectorAll(".page").forEach(p => p.hidden = p.id !== a.dataset.page);
  document.querySelectorAll("#nav a").forEach(x => x.classList.toggle("active", x === a));
  $("nav").classList.remove("open");
});
$("btnMenu").onclick = () => $("nav").classList.toggle("open");

// ---------- live chart ----------
const chart = new Chart($("chart"), {
  type: "line",
  data: { labels: [], datasets: [
    { label: "Soil moisture %", data: [], borderColor: "#16a34a", tension: .3 },
    { label: "Temperature °C", data: [], borderColor: "#f59e0b", tension: .3 },
    { label: "Humidity %", data: [], borderColor: "#3b82f6", tension: .3 }
  ]},
  options: { animation: false, scales: { y: { min: 0, max: 100 } } }
});
function pushChart(s) {
  if (!s.lastUpdated) return;
  const label = new Date(s.lastUpdated * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka" });
  if (chart.data.labels.at(-1) === label) return;
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(s.soilMoisture);
  chart.data.datasets[1].data.push(s.temperature);
  chart.data.datasets[2].data.push(s.humidity ?? null);
  if (chart.data.labels.length > 60) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(d => d.data.shift());
  }
  chart.update();
}

// ---------- show data on screen ----------
function render() {
  const online = status.lastSeen && (Date.now() / 1000 - status.lastSeen) < 30;
  setText("conn", online ? "ESP32 ONLINE" : "ESP32 OFFLINE");
  $("conn").className = "badge " + (online ? "on" : "off");

  const m = sensors.soilMoisture, ok = online && sensors.sensorOk;
  setText("moist", ok ? m + "%" : "--%");
  $("moistBar").style.width = ok ? m + "%" : "0%";
  const low = control.lowMoistureThreshold ?? 30, tgt = control.targetMoisture ?? 80;
  const st = !ok ? "No data" : m < low ? "Dry" : m < tgt ? "Normal" : "Wet";
  setText("moistStatus", st);
  $("moistBar").style.background = st === "Dry" ? "#dc2626" : st === "Normal" ? "#16a34a" : "#2563eb";

  const tempOk = online && sensors.temperature != null;
  const humOk = online && sensors.humidity != null;
  const t = tempOk ? Math.round(sensors.temperature * 10) / 10 : null;
  const h = humOk ? Math.round(sensors.humidity) : null;
  setText("temp", tempOk ? t.toFixed(1) + "°C" : "--°C");
  setText("hum", humOk ? h + "%" : "--%");

  // Money Plant care: cards, banner, popup
  const alerts = [];
  careRow("soil", "careSoilBadge", "careSoilTip", m, "%", low, PLANT.soil.idealLow, PLANT.soil.idealHigh, PLANT.soil.alertHigh, ok, alerts);
  careRow("temp", "careTempBadge", "careTempTip", t, "°C", PLANT.temp.alertLow, PLANT.temp.idealLow, PLANT.temp.idealHigh, PLANT.temp.alertHigh, tempOk, alerts);
  careRow("hum", "careHumBadge", "careHumTip", h, "%", PLANT.hum.alertLow, PLANT.hum.idealLow, PLANT.hum.idealHigh, PLANT.hum.alertHigh, humOk, alerts);
  const banner = $("alertBanner");
  if (banner) banner.hidden = alerts.length === 0;
  setText("alertBannerTxt", alerts.join(" · "));
  const nb = $("btnNotif");
  if (nb) nb.hidden = !("Notification" in window) || Notification.permission === "granted";

  setText("modeTxt", control.mode ?? "--");
  setText("pumpTxt", status.pumpOn ? "ON" : "OFF");
  setText("lastWater", fmt(status.lastWatering));
    if (online && status.slot) {
    setText("slotCnt", (status.slotCount ?? 0) + " / " + (status.slotMax ?? control.maxWaterPerWindow ?? 2));
    setText("slotName", status.slot === 1 ? "🌅 Morning slot" : "🌇 Evening slot");
  } else if (online) {
    setText("slotCnt", "--");
    setText("slotName", "No active slot (AUTO will not water now)");
  } else {
    setText("slotCnt", "--");
    setText("slotName", "ESP32 offline");
  }
  setText("reqCmd", control.pumpCommand ?? "--");
  setText("confPump", status.pumpOn ? "ON" : "OFF");
  document.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("selected", b.dataset.mode === control.mode));

  // settings boxes (fill once, only if empty)
  fillIfEmpty("sTarget", control.targetMoisture ?? 80);
  fillIfEmpty("sLow", control.lowMoistureThreshold ?? 30);
  fillIfEmpty("sW1S", control.window1Start ?? "06:00");
  fillIfEmpty("sW1E", control.window1End ?? "08:00");
  fillIfEmpty("sW2S", control.window2Start ?? "16:00");
  fillIfEmpty("sW2E", control.window2End ?? "17:00");
  fillIfEmpty("sCnt", control.maxWaterPerWindow ?? 2);
  fillIfEmpty("sMax", control.maxPumpRuntimeSeconds ?? 60);
  fillIfEmpty("sTemp", control.tempWarning ?? 38);

  const sm = $("saveMsg");
  if (sm && control.rev && sm.dataset.rev == control.rev)
    sm.textContent = status.ackRev == control.rev
      ? "✅ Saved and received by ESP32"
      : "⏳ Saved, waiting for ESP32…";
}

// ---------- listen to Firebase ----------
let started = false;
function startListeners() {
  if (started) return;
  started = true;
  onValue(ref(db, "plant/control"), s => { control = s.val() || {}; render(); });
  onValue(ref(db, "plant/status"),  s => { status  = s.val() || {}; render(); });
  onValue(ref(db, "plant/sensors"), s => { sensors = s.val() || {}; pushChart(sensors); render(); });
  setInterval(render, 5000);

  onValue(query(ref(db, "plant/history"), limitToLast(50)), s => {
    const rows = Object.values(s.val() || {}).reverse();
    $("histTable").querySelector("tbody").innerHTML = rows.map(r =>
      `<tr><td>${fmt(r.startTs)}</td><td>${fmt(r.endTs)}</td><td>${r.durationSec}s</td><td>${r.mode}</td>
       <td>${r.moistureBefore}%</td><td>${r.moistureAfter}%</td><td>${r.result}</td></tr>`).join("");
  });
  onValue(query(ref(db, "plant/notifications"), limitToLast(50)), s => {
    const items = Object.values(s.val() || {}).reverse();
    $("notifList").innerHTML = items.map(n =>
      `<li><b>${n.type}</b> – ${n.message}<br><small>${fmt(n.ts)}</small></li>`).join("");
    setText("alertCount", items.filter(n =>
      ["low_moisture", "sensor_error", "max_runtime", "temp_warning"].includes(n.type)).length);
  });
}

// ---------- pump buttons ----------
async function sendControl(values, okText) {
  setText("cmdMsg", "Sending…");
  try {
    await update(ref(db, "plant/control"), values);
    setText("cmdMsg", "✅ " + okText);
  } catch (e) {
    setText("cmdMsg", "❌ Failed: " + e.message);
  }
}
document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () =>
  sendControl({ mode: b.dataset.mode, pumpCommand: "OFF" }, "Mode set to " + b.dataset.mode));
$("btnStart").onclick = () => {
  if (control.mode !== "MANUAL") return setText("cmdMsg", "⚠️ Switch to MANUAL first.");
  sendControl({ pumpCommand: "ON" }, "Start requested (the ESP32 must confirm)");
};
$("btnStop").onclick = () => sendControl({ pumpCommand: "OFF" }, "Stop requested");

// ---------- save settings ----------
$("btnSave").onclick = async () => {
  const v = {
    targetMoisture: Number($("sTarget").value),
    lowMoistureThreshold: Number($("sLow").value),
    maxPumpRuntimeSeconds: Number($("sMax").value),
    tempWarning: Number($("sTemp").value),
    window1Start: $("sW1S").value, window1End: $("sW1E").value,
    window2Start: $("sW2S").value, window2End: $("sW2E").value,
    maxWaterPerWindow: Number($("sCnt").value)
  };
  const bad = msg => setText("saveMsg", "❌ " + msg);
  if (!(v.targetMoisture >= 20 && v.targetMoisture <= 100)) return bad("Target must be 20–100");
  if (!(v.lowMoistureThreshold >= 0 && v.lowMoistureThreshold < v.targetMoisture)) return bad("Low threshold must be below target");
    if (!(v.maxPumpRuntimeSeconds >= 1 && v.maxPumpRuntimeSeconds <= 600)) return bad("Runtime must be 1–600 seconds");
  if (!v.window1Start || !v.window1End || !v.window2Start || !v.window2End) return bad("Set all 4 times");
  if (v.window1Start >= v.window1End) return bad("Morning: start must be before end");
  if (v.window2Start >= v.window2End) return bad("Evening: start must be before end");
  if (v.window1End > v.window2Start) return bad("Morning must end before Evening starts");
  if (!Number.isInteger(v.maxWaterPerWindow) || v.maxWaterPerWindow < 1) return bad("Max waterings must be 1 or more");
  v.rev = Math.floor(Date.now() / 1000);
  $("saveMsg").dataset.rev = v.rev;
  setText("saveMsg", "Saving…");
  try { await update(ref(db, "plant/control"), v); }
  catch (e) { setText("saveMsg", "❌ Error: " + e.message); }
};

// ---------- enable popup alerts button ----------
$("btnNotif").onclick = async () => {
  if (!("Notification" in window)) return alert("This browser does not support popup notifications.");
  const p = await Notification.requestPermission();
  if (p === "granted") new Notification("🌱 Popup alerts enabled", { body: "You will be notified when your Money Plant needs attention." });
};

// ---------- countdown to next allowed AUTO watering ----------
function updateCountdown() {
  let t = "--";
  if (control.mode === "AUTO") {
    if (status.pumpOn) t = "Pump running";
    else if (status.nextAutoTs) {
      const left = Math.ceil(status.nextAutoTs - Date.now() / 1000);
      t = left > 0
        ? String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0")
        : "Ready";
    } else t = "Ready";
  }
  setText("cdTxt", t);
}
setInterval(updateCountdown, 1000);