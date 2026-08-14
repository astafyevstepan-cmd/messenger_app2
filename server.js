require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || "super-secret-dev-key-change-me";
const PORT = process.env.PORT || 3000;

const AVATAR_COLORS = ["#e17076", "#7bc862", "#6ec9cb", "#faa774", "#a695e7", "#54cbe1", "#ff9fb0", "#f7b955"];

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- AUTH HELPERS ---------------- */
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

function authMiddleware(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Не авторизован" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Неверный токен" });
  }
}

/* ---------------- ROUTES: AUTH ---------------- */
app.post("/api/register", (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: "Логин от 3 символов, пароль от 4 символов" });
  }
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return res.status(409).json({ error: "Такой логин уже занят" });

  const hash = bcrypt.hashSync(password, 10);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const name = displayName && displayName.trim() ? displayName.trim() : username;

  const info = db
    .prepare("INSERT INTO users (username, password_hash, display_name, color, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(username, hash, name, color, Date.now());

  const user = { id: info.lastInsertRowid, username, display_name: name, color };
  const token = signToken(user);
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ token, user: { id: user.id, username, displayName: name, color } });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) return res.status(401).json({ error: "Неверный логин или пароль" });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Неверный логин или пароль" });

  const token = signToken(user);
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
  res.json({
    token,
    user: { id: user.id, username: user.username, displayName: user.display_name, color: user.color },
  });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT id, username, display_name, color FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });
  res.json({ id: user.id, username: user.username, displayName: user.display_name, color: user.color });
});

/* ---------------- ROUTES: USERS & MESSAGES ---------------- */
app.get("/api/users", authMiddleware, (req, res) => {
  const q = (req.query.q || "").trim();
  let rows;
  if (q) {
    rows = db
      .prepare("SELECT id, username, display_name, color FROM users WHERE id != ? AND (username LIKE ? OR display_name LIKE ?) LIMIT 30")
      .all(req.user.id, `%${q}%`, `%${q}%`);
  } else {
    // список контактов, с которыми уже есть переписка + немного всех остальных
    rows = db
      .prepare(`
        SELECT DISTINCT u.id, u.username, u.display_name, u.color FROM users u
        WHERE u.id IN (
          SELECT to_user FROM messages WHERE from_user = ?
          UNION
          SELECT from_user FROM messages WHERE to_user = ?
        )
      `)
      .all(req.user.id, req.user.id);
  }
  res.json(rows.map(r => ({ id: r.id, username: r.username, displayName: r.display_name, color: r.color })));
});

app.get("/api/users/all", authMiddleware, (req, res) => {
  const rows = db
    .prepare("SELECT id, username, display_name, color FROM users WHERE id != ? ORDER BY display_name")
    .all(req.user.id);
  res.json(rows.map(r => ({ id: r.id, username: r.username, displayName: r.display_name, color: r.color })));
});

app.get("/api/messages/:otherId", authMiddleware, (req, res) => {
  const otherId = parseInt(req.params.otherId, 10);
  const rows = db
    .prepare(`
      SELECT id, from_user, to_user, text, created_at, read FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at ASC
    `)
    .all(req.user.id, otherId, otherId, req.user.id);

  db.prepare("UPDATE messages SET read = 1 WHERE from_user = ? AND to_user = ?").run(otherId, req.user.id);

  res.json(
    rows.map(r => ({
      id: r.id,
      from: r.from_user,
      to: r.to_user,
      text: r.text,
      createdAt: r.created_at,
      read: !!r.read,
    }))
  );
});

app.get("/api/conversations", authMiddleware, (req, res) => {
  const myId = req.user.id;
  const rows = db
    .prepare(`
      SELECT u.id, u.username, u.display_name, u.color,
        (SELECT text FROM messages m2 WHERE (m2.from_user=u.id AND m2.to_user=?) OR (m2.from_user=? AND m2.to_user=u.id) ORDER BY m2.created_at DESC LIMIT 1) AS last_text,
        (SELECT created_at FROM messages m2 WHERE (m2.from_user=u.id AND m2.to_user=?) OR (m2.from_user=? AND m2.to_user=u.id) ORDER BY m2.created_at DESC LIMIT 1) AS last_time,
        (SELECT COUNT(*) FROM messages m3 WHERE m3.from_user=u.id AND m3.to_user=? AND m3.read=0) AS unread
      FROM users u
      WHERE u.id IN (
        SELECT to_user FROM messages WHERE from_user = ?
        UNION
        SELECT from_user FROM messages WHERE to_user = ?
      )
      ORDER BY last_time DESC
    `)
    .all(myId, myId, myId, myId, myId, myId, myId);

  res.json(
    rows.map(r => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      color: r.color,
      lastText: r.last_text,
      lastTime: r.last_time,
      unread: r.unread,
    }))
  );
});

/* ---------------- SOCKET.IO REALTIME ---------------- */
const onlineUsers = new Map(); // userId -> Set(socketId)

io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    (socket.handshake.headers.cookie || "")
      .split(";")
      .map(s => s.trim())
      .find(s => s.startsWith("token="))
      ?.split("=")[1];
  if (!token) return next(new Error("no token"));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.id;
    socket.username = payload.username;
    next();
  } catch (e) {
    next(new Error("invalid token"));
  }
});

io.on("connection", socket => {
  const uid = socket.userId;
  if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());
  onlineUsers.get(uid).add(socket.id);
  io.emit("presence", { userId: uid, online: true });

  socket.on("send_message", ({ to, text }) => {
    if (!text || !text.trim() || !to) return;
    const now = Date.now();
    const info = db
      .prepare("INSERT INTO messages (from_user, to_user, text, created_at, read) VALUES (?, ?, ?, ?, 0)")
      .run(uid, to, text.trim(), now);

    const payload = { id: info.lastInsertRowid, from: uid, to, text: text.trim(), createdAt: now, read: false };

    // отправляем себе (для синхронизации других вкладок/устройств)
    (onlineUsers.get(uid) || []).forEach(sid => io.to(sid).emit("new_message", payload));
    // отправляем получателю, если онлайн
    (onlineUsers.get(to) || []).forEach(sid => io.to(sid).emit("new_message", payload));
  });

  socket.on("typing", ({ to }) => {
    (onlineUsers.get(to) || []).forEach(sid => io.to(sid).emit("typing", { from: uid }));
  });

  socket.on("disconnect", () => {
    const set = onlineUsers.get(uid);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(uid);
        io.emit("presence", { userId: uid, online: false });
      }
    }
  });
});

app.get("/api/online/:id", authMiddleware, (req, res) => {
  res.json({ online: onlineUsers.has(parseInt(req.params.id, 10)) });
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function getLocalIPs() {
  const os = require("os");
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

server.listen(PORT, "0.0.0.0", () => {
  const ips = getLocalIPs();
  console.log("\n========================================");
  console.log("  Мессенджер запущен!");
  console.log("========================================");
  console.log(`  На этом компьютере:  http://localhost:${PORT}`);
  if (ips.length > 0) {
    console.log(`  С других устройств в этой Wi-Fi сети:`);
    ips.forEach(ip => console.log(`    → http://${ip}:${PORT}`));
  } else {
    console.log("  Не удалось определить локальный IP. Проверь подключение к Wi-Fi.");
  }
  console.log("========================================\n");
});
