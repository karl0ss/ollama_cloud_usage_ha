require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const SETTINGS_URL = "https://ollama.com/settings";
const SIGNIN_URL = "https://ollama.com/signin";
const POLL_MINUTES = parseInt(process.env.POLL_MINUTES || "30", 10);
const PORT = parseInt(process.env.PORT || "3214", 10);

const OLLAMA_EMAIL = process.env.OLLAMA_EMAIL || "";
const OLLAMA_PASSWORD = process.env.OLLAMA_PASSWORD || "";
const AUTH_MODE = (process.env.AUTH_MODE || "").toLowerCase();
const HA_URL = (process.env.HA_URL || "").replace(/\/+$/, "");
const HA_TOKEN = process.env.HA_TOKEN || "";
const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, ".cookies.json");

let latestState = null;
let authCookies = null;

function loadCookies() {
  try {
    const data = fs.readFileSync(COOKIE_FILE, "utf-8");
    authCookies = JSON.parse(data);
    console.log("[auth] Loaded cookies from file");
    return true;
  } catch {
    return false;
  }
}

function saveCookies(cookies) {
  authCookies = cookies;
  try {
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  } catch (err) {
    console.error("[auth] Failed to save cookies:", err.message);
  }
}

function cookieString(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function parseSetCookies(setCookieHeaders) {
  if (!setCookieHeaders) return [];
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  return arr.map((header) => {
    const parts = header.split(";")[0].split("=");
    const name = parts[0].trim();
    const value = parts.slice(1).join("=").trim();
    return { name, value };
  });
}

function mergeCookies(existing, incoming) {
  const map = new Map();
  for (const c of existing) map.set(c.name, c);
  for (const c of incoming) map.set(c.name, c);
  return [...map.values()];
}

async function httpRequest(url, options = {}) {
  const headers = { ...options.headers };
  if (authCookies && authCookies.length > 0) {
    headers["Cookie"] = cookieString(authCookies);
  }
  headers["User-Agent"] = headers["User-Agent"] || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

  const res = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
  });

  const setCookies = res.headers.getSetCookie?.() || [];
  if (setCookies.length > 0 && authCookies) {
    const parsed = parseSetCookies(setCookies);
    authCookies = mergeCookies(authCookies, parsed);
    saveCookies(authCookies);
  }

  return res;
}

async function fetchWithCookies(url, options = {}) {
  let res = await httpRequest(url, options);

  const location = res.headers.get("location");
  if (location && (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308)) {
    const nextUrl = new URL(location, url).href;
    return fetchWithCookies(nextUrl, options);
  }

  return res;
}

function findUsage(html, label) {
  const idx = html.indexOf(label);
  if (idx === -1) return null;
  const slice = html.slice(idx, idx + 3000);
  const pct = slice.match(/(\d+(?:\.\d+)?)\s*%/);
  const reset = slice.match(/Resets?\s+in\s+([^<\n.]+?)(?:<|\n|$)/i);
  if (!pct) return null;
  return {
    percent: parseFloat(pct[1]),
    resetsIn: reset ? reset[1].trim().replace(/\s+/g, " ") : null,
  };
}

async function loginWithEmail() {
  console.log("[auth] Logging in with email/password...");

  authCookies = [];

  const getRes = await fetch(SIGNIN_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" },
    redirect: "manual",
  });

  const setCookies = getRes.headers.getSetCookie?.() || [];
  authCookies = mergeCookies(authCookies, parseSetCookies(setCookies));

  let csrfToken = null;
  if (getRes.status >= 200 && getRes.status < 400) {
    const html = await getRes.text();
    const csrfMatch = html.match(/name="csrf[_-]token"\s+(?:value|content)="([^"]+)"/i) ||
      html.match(/<meta\s+name="csrf[_-]token"\s+content="([^"]+)"/i) ||
      html.match(/name="_csrf"\s+value="([^"]+)"/i) ||
      html.match(/name="csrf"\s+value="([^"]+)"/i);
    if (csrfMatch) csrfToken = csrfMatch[1];
  }

  const formHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Referer": SIGNIN_URL,
    "Origin": "https://ollama.com",
  };
  if (authCookies.length > 0) formHeaders["Cookie"] = cookieString(authCookies);

  let body = `email=${encodeURIComponent(OLLAMA_EMAIL)}&password=${encodeURIComponent(OLLAMA_PASSWORD)}`;
  if (csrfToken) body += `&csrf_token=${encodeURIComponent(csrfToken)}&_csrf=${encodeURIComponent(csrfToken)}`;

  const loginRes = await fetch(SIGNIN_URL, {
    method: "POST",
    headers: formHeaders,
    body,
    redirect: "manual",
  });

  const loginCookies = loginRes.headers.getSetCookie?.() || [];
  authCookies = mergeCookies(authCookies, parseSetCookies(loginCookies));

  const location = loginRes.headers.get("location");

  if (loginRes.status === 303 || loginRes.status === 302 || loginRes.status === 301) {
    if (location && !location.includes("/signin")) {
      console.log("[auth] Login successful (redirected to", location, ")");
      saveCookies(authCookies);
      return true;
    }
  }

  if (loginRes.status === 200) {
    const text = await loginRes.text();
    if (text.includes("/settings") || text.includes("dashboard")) {
      console.log("[auth] Login appears successful (200 with settings link)");
      saveCookies(authCookies);
      return true;
    }
    if (text.includes("invalid") || text.includes("wrong") || text.includes("error")) {
      throw new Error("Login failed: invalid credentials");
    }
  }

  if (location && location.includes("/signin")) {
    throw new Error("Login failed: redirected back to signin. Check your credentials.");
  }

  saveCookies(authCookies);

  const verifyRes = await fetchWithCookies(SETTINGS_URL);
  if (verifyRes.url?.includes("/settings") || verifyRes.status === 200) {
    const html = await verifyRes.text();
    if (!html.includes("/signin") || html.includes("Session usage") || html.includes("Weekly usage")) {
      console.log("[auth] Login verified via settings page");
      return true;
    }
  }

  throw new Error("Login failed: could not authenticate with email/password");
}

async function tryWithSavedCookies() {
  console.log("[auth] Trying with saved cookies...");
  const res = await fetchWithCookies(SETTINGS_URL);

  if (res.status !== 200) {
    console.log("[auth] Settings page returned", res.status);
    return false;
  }

  const html = await res.text();

  if (html.includes("Session usage") || html.includes("Weekly usage")) {
    console.log("[auth] Saved cookies are valid!");
    return true;
  }

  if (html.includes("/signin") || html.includes("sign in") || html.length < 2000) {
    console.log("[auth] Cookies expired or invalid, need to re-authenticate");
    return false;
  }

  console.log("[auth] Page doesn't contain usage data, might need re-auth");
  return false;
}

async function pollUsage() {
  let state;

  try {
    if (!authCookies || authCookies.length === 0) {
      if (!loadCookies()) {
        const mode = AUTH_MODE || (OLLAMA_PASSWORD ? "email" : "cookies");
        if (mode === "email") {
          await loginWithEmail();
        } else {
          console.error("[auth] No cookies file found. Export cookies from your browser first (see README).");
          console.error("[auth] Or set OLLAMA_EMAIL + OLLAMA_PASSWORD for email auth.");
          state = { needsLogin: true, error: "No authentication available. Export cookies or set credentials.", fetchedAt: new Date().toISOString() };
          latestState = state;
          return state;
        }
      }
    }

    if (!(await tryWithSavedCookies())) {
      const mode = AUTH_MODE || (OLLAMA_PASSWORD ? "email" : "cookies");
      if (mode === "email") {
        await loginWithEmail();
      } else {
        console.error("[auth] Cookies expired and no email/password configured.");
        state = { needsLogin: true, error: "Session expired. Re-export cookies or set OLLAMA_EMAIL/OLLAMA_PASSWORD.", fetchedAt: new Date().toISOString() };
        latestState = state;
        return state;
      }
    }

    const res = await fetchWithCookies(SETTINGS_URL);
    const html = await res.text();

    const session = findUsage(html, "Session usage");
    const weekly = findUsage(html, "Weekly usage");

    if (session || weekly) {
      state = { session, weekly, fetchedAt: new Date().toISOString() };
    } else {
      if (html.includes("/signin") || html.includes('href="/signin"') || html.length < 2000) {
        console.log("[auth] Session expired, re-authenticating...");
        const mode = AUTH_MODE || (OLLAMA_PASSWORD ? "email" : "cookies");
        if (mode === "email") {
          await loginWithEmail();
          const retryRes = await fetchWithCookies(SETTINGS_URL);
          const retryHtml = await retryRes.text();
          const retrySession = findUsage(retryHtml, "Session usage");
          const retryWeekly = findUsage(retryHtml, "Weekly usage");
          if (retrySession || retryWeekly) {
            state = { session: retrySession, weekly: retryWeekly, fetchedAt: new Date().toISOString() };
          } else {
            state = { needsLogin: true, error: "Re-authentication succeeded but couldn't find usage data.", fetchedAt: new Date().toISOString() };
          }
        } else {
          state = { needsLogin: true, error: "Session expired. Re-export cookies or set OLLAMA_EMAIL/OLLAMA_PASSWORD.", fetchedAt: new Date().toISOString() };
        }
      } else {
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        state = {
          scrapeFailed: true,
          fetchedAt: new Date().toISOString(),
          debug: {
            length: html.length,
            title: titleMatch ? titleMatch[1] : null,
            hasSessionUsage: html.includes("Session usage"),
            hasWeeklyUsage: html.includes("Weekly usage"),
            hasCloudUsage: html.includes("Cloud Usage"),
            sample: html.slice(0, 600),
          },
        };
      }
    }
  } catch (err) {
    state = { error: String(err), fetchedAt: new Date().toISOString() };
  }

  latestState = state;
  console.log("[poll]", JSON.stringify(state, null, 2));

  if (state.session || state.weekly) {
    pushToHA(state).catch((err) => console.error("[ha] push failed:", err.message));
  }

  return state;
}

async function pushToHA(state) {
  if (!HA_URL || !HA_TOKEN) return;

  const sensors = [];
  if (state.session) {
    sensors.push({
      entity_id: "sensor.ollama_session_usage",
      body: stateBody("Ollama Session Usage", "mdi:chart-arc", state.session, state.fetchedAt),
    });
  }
  if (state.weekly) {
    sensors.push({
      entity_id: "sensor.ollama_weekly_usage",
      body: stateBody("Ollama Weekly Usage", "mdi:chart-donut", state.weekly, state.fetchedAt),
    });
  }

  const haHeaders = {
    Authorization: `Bearer ${HA_TOKEN}`,
    "Content-Type": "application/json",
  };

  for (const s of sensors) {
    const url = `${HA_URL}/api/states/${s.entity_id}`;
    console.log(`[ha] POST ${url}`);

    const res = await fetch(url, {
      method: "POST",
      headers: haHeaders,
      body: JSON.stringify(s.body),
    });

    if (res.ok) {
      console.log(`[ha] Updated ${s.entity_id}`);
    } else {
      const text = await res.text();
      console.error(`[ha] Failed ${s.entity_id}: HTTP ${res.status} - ${text}`);

      if (res.status === 404) {
        console.error(`[ha] Hint: 404 usually means the HA URL is wrong or missing /api/states path.`);
        console.error(`[ha] Current HA_URL: ${HA_URL}`);
        console.error(`[ha] Full URL attempted: ${url}`);
        const checkRes = await fetch(`${HA_URL}/api/`, { headers: haHeaders }).catch(() => null);
        if (checkRes) {
          const checkText = await checkRes.text().catch(() => "");
          console.error(`[ha] HA /api/ check: HTTP ${checkRes.status} - ${checkText.slice(0, 200)}`);
        }
      }
    }
  }
}

function stateBody(friendlyName, icon, usage, fetchedAt) {
  return {
    state: usage.percent.toString(),
    attributes: {
      unit_of_measurement: "%",
      state_class: "measurement",
      friendly_name: friendlyName,
      icon,
      resets_in: usage.resetsIn || null,
      last_fetched: fetchedAt,
    },
  };
}

const app = express();
app.set("json spaces", 2);

app.get("/api/usage", (_req, res) => {
  if (!latestState) {
    return res.json({ status: "no_data", message: "No data yet. Wait for first poll." });
  }
  res.json(latestState);
});

app.get("/api/usage/refresh", async (_req, res) => {
  try {
    const state = await pollUsage();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "running",
    authMode: AUTH_MODE || (OLLAMA_PASSWORD ? "email" : "cookies"),
    pollInterval: POLL_MINUTES,
    haConfigured: !!(HA_URL && HA_TOKEN),
    lastFetch: latestState?.fetchedAt || null,
  });
});

app.post("/api/cookies", express.json(), (req, res) => {
  const cookies = req.body;
  if (!Array.isArray(cookies)) {
    return res.status(400).json({ error: "Expected JSON array of cookie objects: [{name, value, ...}]" });
  }
  saveCookies(cookies);
  console.log(`[auth] Received ${cookies.length} cookies via API`);
  res.json({ ok: true, count: cookies.length });
});

async function main() {
  const mode = AUTH_MODE || (OLLAMA_PASSWORD ? "email" : "cookies");

  if (mode === "email" && (!OLLAMA_EMAIL || !OLLAMA_PASSWORD)) {
    console.error("ERROR: OLLAMA_EMAIL and OLLAMA_PASSWORD required for email auth.");
    console.error("For cookie mode: export cookies from your browser (see README) and POST to /api/cookies.");
    process.exit(1);
  }

  console.log(`[start] Auth: ${mode} | Poll: ${POLL_MINUTES} min | API: :${PORT} | HA: ${HA_URL ? "configured" : "off"}`);
  loadCookies();

  await pollUsage();

  setInterval(() => {
    pollUsage().catch((err) => console.error("[poll] error:", err.message));
  }, POLL_MINUTES * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`[start] API listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});