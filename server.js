
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const PORT = Number(process.env.PORT || 10000);
const BASE_URL = process.env.RENDER_EXTERNAL_URL ||
  "https://spotify-jukebox-bedrock-edition.onrender.com";
const REDIRECT_URI = `${BASE_URL}/callback`;
const TOKEN_FILE = path.join("/tmp", "spotify-tokens.json");
const SCOPES = "user-modify-playback-state user-read-playback-state";

const JUKEBOX_TOKEN =
  process.env.JUKEBOX_TOKEN || crypto.randomBytes(32).toString("hex");

if (!process.env.JUKEBOX_TOKEN) {
  console.warn(
    "JUKEBOX_TOKEN no está configurado en Render. Configúralo como variable de entorno."
  );
}

let tokens = null;

try {
  if (fs.existsSync(TOKEN_FILE)) {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  }
} catch {
  console.error("No se pudieron leer los tokens guardados.");
}

const loginAttempts = new Map();

function base64url(buffer) {
  return buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function saveTokens(data) {
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens?.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), {
      mode: 0o600,
    });
  } catch {
    console.error("No se pudieron guardar los tokens.");
  }
}

async function tokenRequest(params) {
  const response = await fetch(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        ...params,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "Error de Spotify"
    );
  }

  saveTokens(data);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function isAuthorized(req, url) {
  const header = req.headers.authorization || "";
  const queryToken = url.searchParams.get("token");

  return header === `Bearer ${JUKEBOX_TOKEN}` ||
    queryToken === JUKEBOX_TOKEN;
}

async function spotify(method, endpoint) {
  if (!tokens) {
    throw new Error("SPOTIFY_NOT_CONNECTED");
  }

  if (Date.now() > tokens.expires_at - 60000) {
    if (!tokens.refresh_token) {
      tokens = null;
      throw new Error("SPOTIFY_LOGIN_REQUIRED");
    }

    await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
  }

  const response = await fetch(
    "https://api.spotify.com/v1/me/player" + endpoint,
    {
      method,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    }
  );

  if (response.status === 204 || response.status === 202) {
    return null;
  }

  if (response.status === 200) {
    return response.json();
  }

  if (response.status === 401) {
    tokens = null;
    throw new Error("SPOTIFY_LOGIN_REQUIRED");
  }

  const error = new Error(
    `Spotify respondió HTTP ${response.status}`
  );
  error.status = response.status;
  throw error;
}

async function performAction(action) {
  const state = await spotify("GET", "");

  if (action === "toggle") {
    await spotify(
      "PUT",
      state?.is_playing ? "/pause" : "/play"
    );
  } else if (action === "next") {
    await spotify("POST", "/next");
  } else if (action === "previous") {
    await spotify("POST", "/previous");
  } else if (
    action === "volume_up" ||
    action === "volume_down"
  ) {
    const volume = state?.device?.volume_percent ?? 50;
    const nextVolume = Math.max(
      0,
      Math.min(
        100,
        volume + (action === "volume_up" ? 10 : -10)
      )
    );

    await spotify(
      "PUT",
      `/volume?volume_percent=${nextVolume}`
    );
  } else {
    const error = new Error("Acción no admitida");
    error.status = 400;
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  let url;

  try {
    url = new URL(req.url, BASE_URL);
  } catch {
    return sendJson(res, 400, {
      error: "URL inválida",
    });
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
    });

    return res.end(
      "Spotify Jukebox está funcionando en Render."
    );
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "spotify-jukebox",
    });
  }

  if (req.method === "GET" && url.pathname === "/login") {
    if (!CLIENT_ID) {
      return sendJson(res, 503, {
        error: "Falta SPOTIFY_CLIENT_ID en Render",
      });
    }

    const state = crypto.randomBytes(24).toString("hex");
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(
      crypto.createHash("sha256").update(verifier).digest()
    );

    loginAttempts.set(state, {
      verifier,
      createdAt: Date.now(),
    });

    for (const [key, value] of loginAttempts) {
      if (Date.now() - value.createdAt > 10 * 60 * 1000) {
        loginAttempts.delete(key);
      }
    }

    const authUrl = new URL(
      "https://accounts.spotify.com/authorize"
    );

    authUrl.search = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      code_challenge_method: "S256",
      code_challenge: challenge,
    }).toString();

    res.writeHead(302, {
      Location: authUrl.toString(),
      "Cache-Control": "no-store",
    });

    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const attempt = loginAttempts.get(state);

    loginAttempts.delete(state);

    if (!code || !attempt) {
      res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      return res.end(
        "Inicio de sesión inválido o caducado. Vuelve a /login."
      );
    }

    try {
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: attempt.verifier,
      });

      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      return res.end(
        "Spotify conectado correctamente. Puedes cerrar esta pestaña."
      );
    } catch (error) {
      console.error(
        "Error al conectar Spotify:",
        error.message
      );

      res.writeHead(502, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      return res.end(
        "No se pudo conectar Spotify. Revisa la configuración y los logs."
      );
    }
  }

  if (
    req.method === "POST" &&
    url.pathname === "/jukebox-action"
  ) {
    if (!isAuthorized(req, url)) {
      return sendJson(res, 401, {
        error: "No autorizado",
      });
    }

    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 16384) {
        req.destroy();
      }
    });

    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await performAction(payload.action);

        sendJson(res, 200, { ok: true });
      } catch (error) {
        console.error(
          "Error de acción:",
          error.message
        );

        const status = error.status || 503;

        sendJson(res, status, {
          error:
            error.message === "SPOTIFY_NOT_CONNECTED" ||
            error.message === "SPOTIFY_LOGIN_REQUIRED"
              ? "Conecta Spotify en /login"
              : error.status === 400
                ? "Acción no admitida"
                : "No se pudo ejecutar la acción de Spotify",
        });
      }
    });

    return;
  }

  sendJson(res, 404, {
    error: "Ruta no encontrada",
  });
});

const wss = new WebSocketServer({
  noServer: true,
});

server.on("upgrade", (req, socket, head) => {
  console.log(
    "Solicitud Upgrade recibida:",
    req.method,
    req.url,
    "| Upgrade:",
    req.headers.upgrade || "ausente"
  );

  let url;

  try {
    url = new URL(req.url, BASE_URL);
  } catch {
    console.warn("WebSocket rechazado: URL inválida.");
    socket.destroy();
    return;
  }

  if (url.pathname !== "/ws") {
    console.warn("WebSocket rechazado: ruta incorrecta.");
    socket.write(
      "HTTP/1.1 404 Not Found\r\n\r\n"
    );
    socket.destroy();
    return;
  }

  if (!isAuthorized(req, url)) {
    console.warn(
      "WebSocket rechazado en /ws: token ausente o incorrecto."
    );
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n\r\n"
    );
    socket.destroy();
    return;
  }

  console.log(
    "Autenticación WebSocket correcta; aceptando conexión."
  );

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

function extractScore(body) {
  const players = body?.result?.players;

  if (Array.isArray(players) && players.length > 0) {
    const score = Number(players[0]?.score);

    if (Number.isFinite(score)) {
      return score;
    }
  }

  const texts = [
    body?.statusMessage,
    body?.statusMessage?.value,
    body?.result?.statusMessage,
    body?.result?.statusMessage?.value,
  ];

  for (const text of texts) {
    if (typeof text !== "string") continue;

    const patterns = [
      /(?:has|tiene)\s+(-?\d+)/i,
      /(?:score|puntuaci[oó]n)\s*(?:is|es|:|=)?\s*(-?\d+)/i,
      /:\s*(-?\d+)\s*$/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);

      if (match) {
        const value = Number.parseInt(match[1], 10);

        if (Number.isFinite(value)) {
          return value;
        }
      }
    }
  }

  return null;
}

wss.on("connection", ws => {
  console.log("Cliente WebSocket conectado.");

  const pending = new Map();

  const run = (commandLine, callback) => {
    if (ws.readyState !== ws.OPEN) return;

    const requestId = crypto.randomUUID();

    if (callback) {
      pending.set(requestId, callback);
    }

    ws.send(JSON.stringify({
      header: {
        version: 1,
        requestId,
        messagePurpose: "commandRequest",
        messageType: "commandRequest",
      },
      body: {
        origin: { type: "player" },
        commandLine,
        version: 1,
      },
    }));
  };

  ws.on("message", raw => {
    try {
      const message = JSON.parse(raw.toString());
      const header = message.header || {};
      const id = header.requestId;
      const callback = pending.get(id);

      if (callback) {
        pending.delete(id);
        callback(message.body || {});
      } else {
        console.log(
          "Mensaje de Minecraft sin petición pendiente:",
          header.messagePurpose ||
            header.messageType ||
            "sin tipo"
        );
      }
    } catch {
      console.error(
        "Mensaje WebSocket inválido; se ignora."
      );
    }
  });

  const timer = setInterval(() => {
    run("scoreboard players get cmd spotify", body => {
      const value = extractScore(body);

      if (value === null) {
        console.log(
          "No se reconoció la puntuación de Minecraft."
        );
        return;
      }

      if (value >= 1 && value <= 5) {
        run("scoreboard players set cmd spotify 0");

        const actions = {
          1: "toggle",
          2: "next",
          3: "previous",
          4: "volume_up",
          5: "volume_down",
        };

        console.log(
          "Orden de jukebox recibida:",
          actions[value]
        );

        performAction(actions[value]).catch(error => {
          console.error(
            "Acción de Spotify fallida:",
            error.message
          );
        });
      }
    });
  }, 1000);

  ws.on("close", () => {
    clearInterval(timer);
    pending.clear();

    console.log("Cliente WebSocket desconectado.");
  });

  ws.on("error", error => {
    console.error(
      "Error WebSocket:",
      error.message
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Servidor activo en el puerto ${PORT}.`
  );
  console.log(
    `Dirección de Spotify: ${REDIRECT_URI}`
  );
  console.log(
    "WebSocket protegido disponible en /ws."
  );
});
urn null;
}

wss.on("connection", ws => {
  console.log("Cliente WebSocket conectado.");

  const pending = new Map();

  const run = (commandLine, callback) => {
    if (ws.readyState !== ws.OPEN) return;

    const requestId = crypto.randomUUID();

    if (callback) {
      pending.set(requestId, callback);
    }

    ws.send(JSON.stringify({
      header: {
        version: 1,
        requestId,
        messagePurpose: "commandRequest",
        messageType: "commandRequest",
      },
      body: {
        origin: { type: "player" },
        commandLine,
        version: 1,
      },
    }));
  };

  ws.on("message", raw => {
    try {
      const message = JSON.parse(raw.toString());
      const header = message.header || {};
      const id = header.requestId;
      const callback = pending.get(id);

      if (callback) {
        pending.delete(id);
        callback(message.body || {});
      } else {
        console.log(
          "Mensaje de Minecraft sin petición pendiente:",
          header.messagePurpose ||
            header.messageType ||
            "sin tipo"
        );
      }
    } catch {
      console.error(
        "Mensaje WebSocket inválido; se ignora."
      );
    }
  });

  const timer = setInterval(() => {
    run("scoreboard players get cmd spotify", body => {
      const value = extractScore(body);

      if (value === null) {
        console.log(
          "No se reconoció la puntuación de Minecraft."
        );
        return;
      }

      if (value >= 1 && value <= 5) {
        run("scoreboard players set cmd spotify 0");

        const actions = {
          1: "toggle",
          2: "next",
          3: "previous",
          4: "volume_up",
          5: "volume_down",
        };

        console.log(
          "Orden de jukebox recibida:",
          actions[value]
        );

        performAction(actions[value]).catch(error => {
          console.error(
            "Acción de Spotify fallida:",
            error.message
          );
        });
      }
    });
  }, 1000);

  ws.on("close", () => {
    clearInterval(timer);
    pending.clear();

    console.log("Cliente WebSocket desconectado.");
  });

  ws.on("error", error => {
    console.error(
      "Error WebSocket:",
      error.message
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Servidor activo en el puerto ${PORT}.`
  );
  console.log(
    `Dirección de Spotify: ${REDIRECT_URI}`
  );
  console.log(
    "WebSocket protegido disponible en /ws."
  );
});
