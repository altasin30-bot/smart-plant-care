// ===== Smart Plant Care - AUTO time windows =====
#include <WiFi.h>
#include <time.h>
#include <Preferences.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <DHT.h>

// ---------- REPLACE THESE 4 ----------
#include "secrets.h"

// ---------- already set for you ----------
#define DB_URL        "smart-plant-care-2966d-default-rtdb.asia-southeast1.firebasedatabase.app"
#define ESP_EMAIL     "esp32@plant.local"
#define SOIL_PIN      34
#define DHT_PIN       21
#define DHT_TYPE      DHT22
#define RELAY_PIN     23
#define AIR_VALUE     4095
#define WATER_VALUE   1333

// ---------- safety ----------
#define OFFLINE_SHUTDOWN_MS 30000UL
#define MIN_OFF_MS          10000UL    // pump off er por minimum gap (manual/auto duitar jonno)
#define AUTO_GAP_MS         30000UL   // AUTO: duibar er moddhe 5 minute
#define HYST                5          // AUTO: moisture < target-5 hole-i start
// ---------------------------------

FirebaseData fbd;
FirebaseAuth auth;
FirebaseConfig config;
DHT dht(DHT_PIN, DHT_TYPE);
Preferences prefs;

String mode = "AUTO", pumpCmd = "OFF";
String w1s = "06:00", w1e = "08:00", w2s = "16:00", w2e = "17:00";
int maxPerWin = 2;
int target = 80, lowThr = 30, maxRun = 60;
float tempWarn = 38;
long rev = 0;

float moisture = 0, temp = 0, hum = 0;
bool sensorOk = false, pumpOn = false, needCmdOff = false;
unsigned long pumpStart = 0, pumpStopAt = 0, lastFbOk = 0;
unsigned long tSensor = 0, tSync = 0, tPush = 0;
float moistureBefore = 0;
String runMode = "AUTO";
long winKey = -1;
int curSlot = 0;
int winCount = 0;
bool pushNow = false;
bool pendingStartNotify = false;
String pendingStartMsg = "";
bool lowAlerted = false, tempAlerted = false, defaultsChecked = false;

// relay: LOW = ON, pin chhere dile = OFF
void pumpHW(bool on) {
  pinMode(RELAY_PIN, OUTPUT_OPEN_DRAIN);
  digitalWrite(RELAY_PIN, on ? LOW : HIGH);
}

bool timeValid() { return time(nullptr) > 1700000000; }

int toMin(const String& s) {
  if (s.length() < 5) return -1;
  return s.substring(0, 2).toInt() * 60 + s.substring(3, 5).toInt();
}

// ekhon kon window e achi? 0 = kono window e na, 1 ba 2 = window number
int currentWindow(long &key) {
  struct tm t;
  if (!timeValid() || !getLocalTime(&t, 10)) return 0;
  int nowM = t.tm_hour * 60 + t.tm_min;
  int a = toMin(w1s), b = toMin(w1e), c = toMin(w2s), d = toMin(w2e);
  int slot = 0;
  if (a >= 0 && b > a && nowM >= a && nowM < b) slot = 1;
  else if (c >= 0 && d > c && nowM >= c && nowM < d) slot = 2;
  if (slot) key = ((long)t.tm_year * 400 + t.tm_yday) * 10 + slot;
  return slot;
}

void notify(const char* type, const String& msg) {
  if (!Firebase.ready()) return;
  FirebaseJson j;
  j.set("ts", (int)time(nullptr)); j.set("type", type); j.set("message", msg);
  Firebase.RTDB.pushJSON(&fbd, "/plant/notifications", &j);
}

void readSensors() {
  long sum = 0;
  for (int i = 0; i < 10; i++) sum += analogRead(SOIL_PIN);
  int raw = sum / 10;
  sensorOk = (raw > 50 && raw <= 4095);
  moisture = constrain(map(raw, AIR_VALUE, WATER_VALUE, 0, 100), 0, 100);
  static unsigned long tDht = 0;
  if (!pumpOn && millis() - tDht > 5000) {
    tDht = millis();
    float t = dht.readTemperature();
    if (!isnan(t)) temp = t;
    float h = dht.readHumidity();
    if (!isnan(h)) hum = h;
  }
}

void startPump(const char* m) {
  if (pumpOn || !sensorOk) return;
  if (pumpStopAt && millis() - pumpStopAt < MIN_OFF_MS) return;
  pumpOn = true; pumpStart = millis(); runMode = m; moistureBefore = moisture;
  pumpHW(true);
  Serial.println(String("PUMP ON (") + m + ")");
  pendingStartMsg = String("Pump started (") + m + ") at " + (int)moisture + "%";
  pendingStartNotify = true;
}

void stopPump(const char* result) {
  if (!pumpOn) return;
  pumpHW(false); pumpOn = false; pumpStopAt = millis();
  Serial.println(String("PUMP OFF: ") + result);
  
  int dur = (millis() - pumpStart) / 1000;
  if (pumpCmd == "ON") needCmdOff = true;
  pumpCmd = "OFF";
  if (Firebase.ready()) {
    time_t now = time(nullptr);
    FirebaseJson j;
    j.set("startTs", (int)(now - dur)); j.set("endTs", (int)now);
    j.set("durationSec", dur); j.set("mode", runMode);
    j.set("moistureBefore", (int)moistureBefore); j.set("moistureAfter", (int)moisture);
    j.set("result", result);
    Firebase.RTDB.pushJSON(&fbd, "/plant/history", &j);
    Firebase.RTDB.setInt(&fbd, "/plant/status/lastWatering", (int)now);
    Firebase.RTDB.setInt(&fbd, "/plant/status/pumpOn", 0);
    Firebase.RTDB.setString(&fbd, "/plant/control/pumpCommand", "OFF");
  }
  String r = result;
  if (r == "completed") notify("target_reached", "Target moisture reached");
  else if (r == "timeout") notify("max_runtime", "Max pump runtime exceeded");
  else if (r == "sensor_error") notify("sensor_error", "Pump stopped: sensor error");
  notify("pump_stopped", String("Pump stopped: ") + result);
}

void syncControl() {
  if (!Firebase.ready()) return;
  if (!defaultsChecked) {
    defaultsChecked = true;
    if (!Firebase.RTDB.pathExisted(&fbd, "/plant/control")) {
      FirebaseJson d;
      d.set("mode", "AUTO"); d.set("pumpCommand", "OFF"); d.set("targetMoisture", 80);
      d.set("lowMoistureThreshold", 30); d.set("maxPumpRuntimeSeconds", 60);
      d.set("tempWarning", 38);
      d.set("window1Start", "06:00"); d.set("window1End", "08:00");
      d.set("window2Start", "16:00"); d.set("window2End", "17:00");
      d.set("maxWaterPerWindow", 2);
      Firebase.RTDB.setJSON(&fbd, "/plant/control", &d);
    }
  }
  if (Firebase.RTDB.getJSON(&fbd, "/plant/control")) {
    lastFbOk = millis();
    FirebaseJson& j = fbd.jsonObject(); FirebaseJsonData d;
    if (j.get(d, "mode"))                  mode = d.stringValue;
    if (j.get(d, "pumpCommand"))           pumpCmd = d.stringValue;
    if (j.get(d, "targetMoisture"))        target = d.intValue;
    if (j.get(d, "lowMoistureThreshold"))  lowThr = d.intValue;
    if (j.get(d, "maxPumpRuntimeSeconds")) maxRun = d.intValue;
    if (j.get(d, "tempWarning"))           tempWarn = d.floatValue;
    if (j.get(d, "window1Start"))          w1s = d.stringValue;
    if (j.get(d, "window1End"))            w1e = d.stringValue;
    if (j.get(d, "window2Start"))          w2s = d.stringValue;
    if (j.get(d, "window2End"))            w2e = d.stringValue;
    if (j.get(d, "maxWaterPerWindow"))     maxPerWin = d.intValue;
    if (pumpCmd == "OFF") needCmdOff = false;
    if (mode == "AUTO" && pumpCmd == "ON") {
      pumpCmd = "OFF";
      Firebase.RTDB.setString(&fbd, "/plant/control/pumpCommand", "OFF");
    }
    if (j.get(d, "rev")) {
      long r = d.intValue;
      if (r != rev) { rev = r; Firebase.RTDB.setInt(&fbd, "/plant/status/ackRev", (int)rev); }
    }
  }
}

void pushStatus() {
  if (!Firebase.ready()) return;
  FirebaseJson s, st;
  s.set("soilMoisture", (int)moisture); s.set("temperature", temp);
  s.set("humidity", hum);
  s.set("lastUpdated", (int)time(nullptr)); s.set("sensorOk", sensorOk);
  st.set("pumpOn", pumpOn); st.set("lastSeen", (int)time(nullptr));
  long wk; int ws = currentWindow(wk);
  st.set("slot", ws);
  st.set("slotCount", ws ? ((wk == winKey) ? winCount : 0) : 0);
  st.set("slotMax", maxPerWin);
  if (Firebase.RTDB.updateNode(&fbd, "/plant/sensors", &s) &&
      Firebase.RTDB.updateNode(&fbd, "/plant/status", &st)) lastFbOk = millis();
}

// ---------- AUTO: shudhu time window er bhitore, sorboccho maxPerWin bar ----------
void autoWatering() {
  if (mode != "AUTO" || pumpOn || !sensorOk) return;
  long key;
  if (!currentWindow(key)) return;                       // window er baire: pani dibe na
  if (key != winKey) {                                   // notun window: count 0
    winKey = key; winCount = 0;
    
  }
  if (winCount >= maxPerWin) return;                     // ei window e limit shesh
  if (moisture >= target - HYST) return;                 // mati ekhono jotheshto bhej
  if (pumpStopAt && millis() - pumpStopAt < AUTO_GAP_MS) return;
  startPump("AUTO");
    if (pumpOn) {
    winCount++;
    Serial.printf("AUTO watering %d/%d in this window\n", winCount, maxPerWin);
  }
}

void setup() {
  Serial.begin(115200);
  pumpHW(false);
  analogReadResolution(12);
  dht.begin();
  
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Wi-Fi");
  unsigned long w = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - w < 20000) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " FAILED");

  configTzTime("<+06>-6", "pool.ntp.org", "time.google.com");   // Bangladesh
  config.api_key = API_KEY;
  config.database_url = DB_URL;
  auth.user.email = ESP_EMAIL;
  auth.user.password = ESP_PASSWORD;
  config.token_status_callback = tokenStatusCallback;
  Firebase.reconnectNetwork(true);
  Firebase.begin(&config, &auth);
  lastFbOk = millis();
}

void loop() {
  unsigned long now = millis();

  if (now - tSensor > 2000) {
    tSensor = now; readSensors();
    long k; int wn = currentWindow(k);
    Serial.printf("moisture=%d%% temp=%.1fC hum=%.0f%% pump=%d mode=%s window=%d count=%d/%d\n",
                  (int)moisture, temp, hum, pumpOn, mode.c_str(), wn, winCount, maxPerWin);
  }

  // ----- safety (Wi-Fi na thakleo cholbe) -----
  if (pumpOn) {
    long k;
    if (!sensorOk)                                              stopPump("sensor_error");
    else if (moisture >= target && runMode != "MANUAL")         stopPump("completed");
    else if (now - pumpStart > (unsigned long)maxRun * 1000UL)  stopPump("timeout");
    else if (now - lastFbOk > OFFLINE_SHUTDOWN_MS)              stopPump("offline");
    else if (runMode == "MANUAL" && (mode != "MANUAL" || pumpCmd == "OFF")) stopPump("stopped_manually");
    else if (runMode == "MANUAL" && mode == "AUTO")             stopPump("stopped_manually");
    else if (runMode == "AUTO" && !currentWindow(k))            stopPump("window_ended");
  }

  if (now - tSync > 1000) { tSync = now; syncControl(); }
  if (now - tPush > 3000) { tPush = now; pushStatus(); }

  if (pendingStartNotify && now - pumpStart > 2000) {
    pendingStartNotify = false;
    notify("pump_started", pendingStartMsg);
  }

  autoWatering();

    if (mode == "MANUAL" && pumpCmd == "ON" && !needCmdOff && !pumpOn && sensorOk)
    startPump("MANUAL");

  // alerts
  if (sensorOk && moisture < lowThr && !lowAlerted) { lowAlerted = true; notify("low_moisture", "Soil is too dry: " + String((int)moisture) + "%"); }
  if (moisture >= lowThr + 5) lowAlerted = false;
  if (temp > tempWarn && !tempAlerted) { tempAlerted = true; notify("temp_warning", "High temperature: " + String(temp, 1) + "C"); }
  if (temp < tempWarn - 1) tempAlerted = false;
  if (!sensorOk && now > 15000) { static unsigned long ls = 0; if (now - ls > 300000) { ls = now; notify("sensor_error", "Soil sensor reading invalid"); } }
}