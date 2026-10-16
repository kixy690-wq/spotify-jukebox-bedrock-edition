// Requiere Node 18+ y Spotify Premium.
// Uso: SPOTIFY_CLIENT_ID=tu_id node server.js
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT = "http://127.0.0.1:8888/callback";
const SCOPES = "user-modify-playback-state user-read-playback-state";
const TOKEN_FILE = "tokens.json";
const b64 = (b) => b.toString("base64url");

let tokens = fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE)) : null;

async function tokenRequest(params) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(JSON.stringify(d));
  tokens = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || tokens?.refresh_token,
    expires_at: Date.now() + d.expires_in * 1000,
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
}

function login() {
  const verifier = b64(crypto.randomBytes(64));
  const challenge = b64(crypto.createHash("sha256").update(verifier).digest());
  const url = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT,
    scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge,
  });
  console.log("Abre este enlace para conectar Spotify:\n" + url);
  const srv = http.createServer(async (req, res) => {
    const code = new URL(req.url, REDIRECT).searchParams.get("code");
    if (!code) return res.end("Falta el código");
    try {
      await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
      res.end("Spotify conectado. Ya puedes cerrar esta pestaña.");
      console.log("Spotify conectado.");
    } catch (e) { res.end("Error: " + e.message); }
    srv.close();
  }).listen(8888, "127.0.0.1");
}

async function spotify(method, path) {
  if (!tokens) return null;
  if (Date.now() > tokens.expires_at - 60000)
    await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  const res = await fetch("https://api.spotify.com/v1/me/player" + path, {
    method, headers: { Authorization: "Bearer " + tokens.access_token },
  });
  return res.status === 200 ? res.json() : null;
}

async function action(code) {
  const state = await spotify("GET", "");
  if (code === 1) await spotify("PUT", state?.is_playing ? "/pause" : "/play");
  if (code === 2) await spotify("POST", "/next");
  if (code === 3) await spotify("POST", "/previous");
  if (code === 4 || code === 5) {
    const v = state?.device?.volume_percent ?? 50;
    const nv = Math.max(0, Math.min(100, v + (code === 4 ? 10 : -10)));
    await spotify("PUT", "/volume?volume_percent=" + nv);
  }
}

// Minecraft se conecta aquí con: /wsserver localhost:3000
const wss = new WebSocketServer({ port: 3000 });
wss.on("connection", (ws) => {
  console.log("Minecraft conectado.");
  const pending = new Map();
  const run = (commandLine, cb) => {
    const id = crypto.randomUUID();
    if (cb) pending.set(id, cb);
    ws.send(JSON.stringify({
      header: { version: 1, requestId: id, messagePurpose: "commandRequest", messageType: "commandRequest" },
      body: { origin: { type: "player" }, commandLine, version: 1 },
    }));
  };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    const cb = pending.get(m.header?.requestId);
    if (cb) { pending.delete(m.header.requestId); cb(m.body); }
  });
  const timer = setInterval(() => {
    run("scoreboard players get cmd spotify", (body) => {
      const n = parseInt(/has (-?\d+)/.exec(body?.statusMessage || "")?.[1] || "0", 10);
      if (n > 0) {
        run("scoreboard players set cmd spotify 0");
        action(n).catch(console.error);
      }
    });
  }, 300);
  ws.on("close", () => clearInterval(timer));
});


// HTTP bridge for Java plugin and Bedrock script.
// Actions control Spotify; they do not stream Spotify audio into Minecraft.
const actionServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST" || req.url !== "/jukebox-action") {
    res.writeHead(404); return res.end(JSON.stringify({ error: "Not found" }));
  }
  let body = "";
  req.on("data", chunk => { body += chunk; if (body.length > 16384) req.destroy(); });
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body || "{}");
      const actionName = payload.action;
      const state = await spotify("GET", "");
      if (!tokens) { res.writeHead(503); return res.end(JSON.stringify({ error: "Spotify not connected" })); }
      if (actionName === "toggle") await spotify("PUT", state?.is_playing ? "/pause" : "/play");
      else if (actionName === "next") await spotify("POST", "/next");
      else if (actionName === "previous") await spotify("POST", "/previous");
      else if (actionName === "volume_up" || actionName === "volume_down") {
        const volume = state?.device?.volume_percent ?? 50;
        const nextVolume = Math.max(0, Math.min(100, volume + (actionName === "volume_up" ? 10 : -10)));
        await spotify("PUT", "/volume?volume_percent=" + nextVolume);
      } else { res.writeHead(400); return res.end(JSON.stringify({ error: "Unsupported action" })); }
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error("HTTP action error:", e);
      res.writeHead(500); res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});
actionServer.listen(3001, "0.0.0.0", () => console.log("HTTP bridge en puerto 3001."));

if (!CLIENT_ID) console.log("Falta SPOTIFY_CLIENT_ID");
else if (!tokens) login();
console.log("Esperando a Minecraft en el puerto 3000...");
