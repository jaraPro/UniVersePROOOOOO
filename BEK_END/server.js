const express = require("express");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const cors = require("cors");
const app = express();

app.use(express.json());
app.use(cors());

const SECRET = "secret123";
let db = require("./db.json");

function saveDB() {
  fs.writeFileSync("./db.json", JSON.stringify(db, null, 2));
}

function trimText(value, maxLength = 4000) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLength);
}

function buildLocalAiGuideReply(message, context) {
  const text = String(message || "").toLowerCase();

  if (!text.trim()) {
    return "Напишите вопрос, и я помогу с выбором вуза, документами и стратегией поступления.";
  }

  if (text.includes("привет") || text.includes("hello") || text.includes("hi")) {
    return "Привет! Я ИИ-гид. Помогу выбрать университет, собрать документы и спланировать поступление.";
  }

  if (text.includes("документ") || text.includes("что нужно") || text.includes("справк")) {
    return [
      "Обычно для поступления нужны:",
      "1. Паспорт/удостоверение личности",
      "2. Аттестат или диплом с приложением",
      "3. Результаты экзаменов (если требуются)",
      "4. Медицинская справка и фото",
      "",
      "Финальный список уточняйте на сайте университета."
    ].join("\n");
  }

  if (text.includes("подбери") || text.includes("какой университет") || text.includes("какой вуз")) {
    return [
      "Чтобы подобрать вуз точнее, напишите:",
      "1. город/страну",
      "2. направление",
      "3. бюджет и нужен ли грант",
      context ? `Контекст: ${trimText(String(context), 200)}` : ""
    ].filter(Boolean).join("\n");
  }

  return "Могу помочь с выбором университета, документами и поэтапным планом поступления. Уточните город, направление и бюджет.";
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role || "user" },
    SECRET,
    { expiresIn: "7d" }
  );
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "BEK_END" });
});

app.post("/api/auth/login", (req, res) => {
  const email = trimText(req.body?.email, 200).toLowerCase();
  const password = trimText(req.body?.password, 200);

  const user = Array.isArray(db.users)
    ? db.users.find((u) => String(u.email || "").toLowerCase() === email && String(u.password || "") === password)
    : null;

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  return res.json({ token: signToken(user), user: { id: user.id, email: user.email, role: user.role || "user" } });
});

app.post("/api/auth/register", (req, res) => {
  const email = trimText(req.body?.email, 200).toLowerCase();
  const password = trimText(req.body?.password, 200);

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  db.users = Array.isArray(db.users) ? db.users : [];
  if (db.users.some((u) => String(u.email || "").toLowerCase() === email)) {
    return res.status(400).json({ error: "User already exists" });
  }

  const user = {
    id: Date.now(),
    email,
    password,
    role: "user",
  };

  db.users.push(user);
  saveDB();

  return res.status(201).json({ token: signToken(user), user: { id: user.id, email: user.email, role: user.role } });
});

app.post("/api/ai-guide/chat", (req, res) => {
  const message = trimText(req.body?.message, 1600);
  const context = trimText(req.body?.context, 2000);

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  return res.json({
    reply: buildLocalAiGuideReply(message, context),
    model: "local-router",
    createdAt: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 5052;
app.listen(PORT, () => {
  console.log(`BEK_END server started on port ${PORT}`);
});