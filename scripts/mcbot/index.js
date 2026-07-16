/**
 * ============================================================
 * 项目名称：Pathfinder PRO (2025 安全精简版)
 * 核心增强：拟人词库、错别字模拟、智能回嘴、进服问候
 * 机器人增强：翼龙守护进程 (每3分钟自动检测开机)
 * 修复：IPv6 监听 / 环境变量登录 / 底层错误捕获 / 重连限制
 * ============================================================
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// === 全局错误处理（防止未捕获异常导致进程退出） ===
process.on('uncaughtException', (err) => {
    console.error('【未捕获异常】', err.message);
    // 不退出进程，保持 HTTP 服务可用
});
process.on('unhandledRejection', (reason) => {
    console.error('【未处理的Promise拒绝】', reason);
});

const mineflayer = require("mineflayer");
const express = require("express");
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const activeBots = new Map();
const CONFIG_FILE = path.join(__dirname, 'bots_config.json');
const mcDataCache = new Map();
const retryCountMap = new Map();  // 记录重连次数，防止无限重连

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// === 登录认证（优先使用环境变量） ===
const LOGIN_USER = process.env.LOGIN_USER || 'wbxl0';
const LOGIN_PASS = process.env.LOGIN_PASS || '0wbxl';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

function createSessionToken() {
    return crypto.createHmac('sha256', SESSION_SECRET)
        .update(`${LOGIN_USER}:${LOGIN_PASS}`)
        .digest('hex');
}

function parseCookies(req) {
    return Object.fromEntries(
        (req.headers.cookie || '')
            .split(';')
            .map(v => v.trim().split('=').map(decodeURIComponent))
            .filter(v => v[0])
    );
}

function isAuthenticated(req) {
    return parseCookies(req).panel_session === createSessionToken();
}

function renderLogin(error = '') {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>登录 - Pathfinder PRO</title><script src="https://cdn.tailwindcss.com"></script></head><body class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4"><form method="POST" action="/login" class="w-full max-w-sm bg-slate-900/80 border border-white/10 rounded-3xl p-8 shadow-2xl"><h1 class="text-2xl font-black mb-2">Pathfinder PRO</h1><p class="text-sm text-slate-500 mb-6">请输入账号密码登录面板</p>${error ? `<div class="mb-4 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl p-3">${error}</div>` : ''}<label class="block text-xs font-bold text-slate-400 mb-2">账号</label><input name="username" autocomplete="username" class="w-full mb-4 bg-black/40 border border-white/10 rounded-xl px-4 py-3 outline-none focus:border-blue-500" autofocus><label class="block text-xs font-bold text-slate-400 mb-2">密码</label><input name="password" type="password" autocomplete="current-password" class="w-full mb-6 bg-black/40 border border-white/10 rounded-xl px-4 py-3 outline-none focus:border-blue-500"><button class="w-full bg-blue-600 hover:bg-blue-500 rounded-xl py-3 font-bold transition-colors">登录</button></form></body></html>`;
}

app.get('/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/');
    res.send(renderLogin());
});

app.post('/login', (req, res) => {
    if (req.body.username === LOGIN_USER && req.body.password === LOGIN_PASS) {
        res.setHeader('Set-Cookie', `panel_session=${createSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
        return res.redirect('/');
    }
    res.status(401).send(renderLogin('账号或密码错误'));
});

app.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'panel_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.redirect('/login');
});

app.use((req, res, next) => {
    if (req.path === '/login') return next();
    if (isAuthenticated(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, error: 'unauthorized' });
    res.redirect('/login');
});

// --- [ 1. 拟人化深度词库矩阵 ] ---
const CHAT_DB = {
    idle: ["有人吗", "2333", "啧", "挂机中", "emm", "好无聊啊", "这服人怎么这么少", "有点卡啊", "这延迟绝了", "我先挂会机", "刷点东西真累", "有人带带萌新吗", "woc刚才那个怪", "有人在不", "又是努力挂机的一天", "这天气不错", "有人聊天吗", "刚才卡了一下", "我去倒杯水", "先眯一会", "草（一种植物）", "害"],
    interaction: ["？", "你说啥", "没注意看", "哦哦", "搜嘎", "确实", "我也是这么想的", "哈哈哈哈", "666", "强啊大佬", "nb", "可以的", "羡慕了", "别cue我", "在呢"],
    suffixes: ["~", "...", "捏", "哈", "呀", "！", "？", "w"],
    typos: { "挂机": ["刮机", "挂机机"], "有人": ["友谊", "有仁"], "怎么": ["咋"], "没有": ["木有"] }
};

function generateNaturalChat(type = 'idle') {
    let pool = CHAT_DB[type];
    let msg = pool[Math.floor(Math.random() * pool.length)];
    if (Math.random() > 0.9) {
        for (let key in CHAT_DB.typos) {
            if (msg.includes(key)) {
                msg = msg.replace(key, CHAT_DB.typos[key][Math.floor(Math.random() * CHAT_DB.typos[key].length)]);
                break;
            }
        }
    }
    if (Math.random() > 0.7) msg += CHAT_DB.suffixes[Math.floor(Math.random() * CHAT_DB.suffixes.length)];
    if (Math.random() > 0.8) msg = (Math.random() > 0.5 ? " " : "") + msg + (Math.random() > 0.5 ? " " : "");
    return msg;
}

// --- [ 2. 内存监控与自愈逻辑 ] ---
function getMemoryStatus() {
    const used = process.memoryUsage().rss;
    let total = os.totalmem();
    if (process.env.SERVER_MEMORY) {
        total = parseInt(process.env.SERVER_MEMORY) * 1024 * 1024;
    } else {
        try {
            if (fsSync.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
                const limit = parseInt(fsSync.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
                if (limit < 9223372036854771712) total = limit;
            } else if (fsSync.existsSync('/sys/fs/cgroup/memory.max')) {
                const limit = fsSync.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
                if (limit !== 'max') total = parseInt(limit);
            }
        } catch (e) {}
    }
    const percent = ((used / total) * 100).toFixed(1);
    return { used: (used / 1024 / 1024).toFixed(1), total: (total / 1024 / 1024).toFixed(0), percent };
}

// 定时清理，并限制机器人数量
setInterval(() => {
    const status = getMemoryStatus();
    if (parseFloat(status.percent) >= 70) {
        mcDataCache.clear();
        activeBots.forEach(bot => {
            bot.logs = bot.logs.slice(0, 5);
        });
        // 内存紧张时，只保留第一个机器人，其余断开
        if (parseFloat(status.percent) >= 80 && activeBots.size > 1) {
            const botsArray = Array.from(activeBots.entries());
            for (let i = 1; i < botsArray.length; i++) {
                const [bid, bm] = botsArray[i];
                if (bm.instance) {
                    bm.instance.removeAllListeners();
                    bm.instance.end();
                }
                activeBots.delete(bid);
                retryCountMap.delete(bid);
                bm.pushLog('🛑 内存紧急，已强制断开', 'text-red-600');
            }
        }
    }
}, 15000);

// --- [ 3. 重启指令序列核心逻辑 ] ---
function executeRestartSequence(botInstance, botMeta) {
    if (!botInstance || !botInstance.entity) return;
    botInstance.chat('/restart');
    botMeta.pushLog(`⚡ 重启序列(1/2): /restart`, 'text-red-400 font-bold');
    setTimeout(() => {
        if (botInstance && botInstance.entity) {
            botInstance.chat('restart');
            botMeta.pushLog(`⚡ 重启序列(2/2): restart`, 'text-red-500 font-bold');
        }
    }, 800);
    botMeta.lastRestartTick = Date.now();
}

// --- [ 4. 核心持久化与机器人工厂 ] ---
async function saveBotsConfig() {
    try {
        const config = Array.from(activeBots.values()).map(b => ({
            host: b.targetHost,
            port: b.targetPort,
            username: b.username,
            serverName: b.serverName,
            settings: b.settings,
            logs: b.logs.slice(0, 30)
        }));
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (err) {}
}

async function createSmartBot(id, host, port, username, existingLogs = [], settings = null, serverName = '') {
    let finalHost = host.trim(),
        finalPort = parseInt(port) || 25565;
    if (finalHost.includes(':')) {
        const parts = finalHost.split(':');
        finalHost = parts[0];
        finalPort = parseInt(parts[1]) || 25565;
    }
    const displayName = (serverName || '').trim();
    const defaultSettings = {
        walk: false,
        ai: true,
        chat: false,
        restartInterval: 0,
        pterodactyl: { url: '', key: '', id: '', defaultDir: '/', guard: false }
    };
    const botMeta = {
        id,
        serverName: displayName,
        username,
        targetHost: finalHost,
        targetPort: finalPort,
        status: "连接中",
        logs: Array.isArray(existingLogs) ? existingLogs.slice(0, 30) : [],
        settings: settings || defaultSettings,
        instance: null,
        afkTimer: null,
        isRepairing: false,
        lastRestartTick: Date.now(),
        isMoving: false
    };
    activeBots.set(id, botMeta);

    const pushLog = (msg, colorClass = '') => {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        botMeta.logs.unshift({ time, msg, color: colorClass });
        if (botMeta.logs.length > 30) botMeta.logs = botMeta.logs.slice(0, 30);
    };
    botMeta.pushLog = pushLog;

    try {
        const bot = mineflayer.createBot({
            host: finalHost,
            port: finalPort,
            username: username,
            auth: 'offline',
            hideErrors: true,
            physicsEnabled: botMeta.settings.walk,
            connectTimeout: 20000
        });
        bot.loadPlugin(pathfinder);
        botMeta.instance = bot;

        // === 捕获底层 socket 错误，防止进程崩溃 ===
        bot.once('login', () => {
            if (bot._client) {
                bot._client.on('error', (err) => {
                    pushLog(`❌ 连接底层错误: ${err.message}`, 'text-red-500');
                    attemptRepair(id, botMeta, '底层错误');
                });
            }
        });

        bot.once('spawn', () => {
            // 成功上线，重置重试计数
            retryCountMap.set(id, 0);
            botMeta.status = "在线";
            botMeta.centerPos = bot.entity.position.clone();
            pushLog(`✅ 成功进入服务器`, 'text-emerald-400 font-bold');

            let mcData;
            try {
                mcData = mcDataCache.get(bot.version) || require('minecraft-data')(bot.version);
                if (mcData) mcDataCache.set(bot.version, mcData);
            } catch (e) {
                pushLog(`❌ 协议不支持`, 'text-red-500');
                return bot.end();
            }

            const movements = new Movements(bot, mcData);
            movements.canDig = false;
            bot.pathfinder.setMovements(movements);

            // 进服问候
            setTimeout(() => {
                if (bot.entity) {
                    bot.chat("Hello everyone, glad to be here!");
                    pushLog(`📣 Join greeting: Hello everyone, glad to be here!`, 'text-purple-400 font-bold');
                }
            }, 2000);

            bot.on('chat', (sender, message) => {
                if (sender === bot.username) return;
                if (botMeta.settings.ai && Math.random() > 0.75) {
                    setTimeout(() => {
                        if (bot.entity) {
                            const reply = generateNaturalChat('interaction');
                            bot.chat(reply);
                            pushLog(`💬 回复 ${sender}: ${reply}`, 'text-cyan-400');
                        }
                    }, 1000 + Math.random() * 4000);
                }
            });

            botMeta.afkTimer = setInterval(() => {
                if (!bot.entity) return;
                if (botMeta.settings.chat && Math.random() > 0.65) {
                    const msg = generateNaturalChat('idle');
                    bot.chat(msg);
                    pushLog(`🗣️ 自动喊话: ${msg}`, 'text-yellow-400');
                }
                if (botMeta.settings.restartInterval > 0 && Date.now() - botMeta.lastRestartTick > botMeta.settings.restartInterval * 60000) {
                    executeRestartSequence(bot, botMeta);
                }
                if (botMeta.settings.walk && botMeta.centerPos && !botMeta.isMoving) {
                    botMeta.isMoving = true;
                    const r = 3 + Math.random() * 6,
                        a = Math.random() * Math.PI * 2;
                    bot.pathfinder.setGoal(new goals.GoalNear(
                        botMeta.centerPos.x + Math.cos(a) * r,
                        botMeta.centerPos.y,
                        botMeta.centerPos.z + Math.sin(a) * r,
                        1
                    ));
                    setTimeout(() => { botMeta.isMoving = false; }, 8000);
                }
            }, 20000);
        });

        bot.on('end', () => attemptRepair(id, botMeta, '断开'));
        bot.on('error', (err) => {
            pushLog(`❌ 机器人错误: ${err.message}`, 'text-red-500');
            attemptRepair(id, botMeta, '错误');
        });
    } catch (err) {
        botMeta.status = "创建失败";
        pushLog(`❌ 创建失败: ${err.message}`, 'text-red-500');
    }
    saveBotsConfig();
}

// 重试逻辑，限制次数，指数退避
function attemptRepair(id, botMeta, reason) {
    if (!activeBots.has(id) || botMeta.isRepairing) return;

    let retries = retryCountMap.get(id) || 0;
    const MAX_RETRIES = 5;
    if (retries >= MAX_RETRIES) {
        botMeta.status = "重连失败(已达上限)";
        botMeta.pushLog(`⛔ 连续重连失败 ${MAX_RETRIES} 次，已停止`, 'text-red-600 font-bold');
        retryCountMap.delete(id);
        return;
    }
    retries++;
    retryCountMap.set(id, retries);

    botMeta.isRepairing = true;
    botMeta.status = "重连中";
    if (botMeta.instance) {
        botMeta.instance.removeAllListeners();
        try { botMeta.instance.end(); } catch (e) {}
        botMeta.instance = null;
    }
    if (botMeta.afkTimer) clearInterval(botMeta.afkTimer);

    const delay = Math.min(10000 * Math.pow(2, retries - 1), 300000);
    botMeta.pushLog(`⏳ ${retries}/${MAX_RETRIES} 次重试，${delay/1000}s 后重连`, 'text-yellow-400');
    setTimeout(() => {
        if (!activeBots.has(id)) {
            retryCountMap.delete(id);
            return;
        }
        botMeta.isRepairing = false;
        createSmartBot(id, botMeta.targetHost, botMeta.targetPort, botMeta.username, botMeta.logs, botMeta.settings, botMeta.serverName);
    }, delay);
}

// --- [ 5. API 接口逻辑 - 机器人 ] ---
app.post("/api/bots/:id/restart-now", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b && b.instance) { executeRestartSequence(b.instance, b); res.json({ success: true }); }
    else res.status(404).json({ success: false });
});
app.post("/api/bots/:id/toggle", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b) {
        const type = req.body.type;
        b.settings[type] = !b.settings[type];
        const statusText = b.settings[type] ? '开启' : '关闭';
        const label = type === 'ai' ? '👁️ AI视角' : (type === 'walk' ? '👣 物理巡逻' : '💬 拟人喊话');
        b.pushLog(`⚙️ 手动操作: ${label} 已${statusText}`, b.settings[type] ? 'text-blue-400' : 'text-slate-400');
        if (type === 'walk' && b.instance) {
            b.instance.physicsEnabled = b.settings.walk;
            if (!b.settings.walk) { b.instance.pathfinder.setGoal(null); b.isMoving = false; }
        }
        saveBotsConfig();
        res.json({ success: true });
    }
});
app.post("/api/bots/:id/upload", upload.single('file'), async (req, res) => {
    const b = activeBots.get(req.params.id);
    if (!b || !b.settings.pterodactyl.url || !req.file) return res.status(400).json({ success: false });
    const { url, key, id, defaultDir } = b.settings.pterodactyl;
    b.pushLog(`🚀 同步文件: ${req.file.originalname} -> 翼龙`, 'text-blue-400 font-bold');
    try {
        const getUrlResp = await axios.get(`${url}/api/client/servers/${id}/files/upload`, {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const uploadUrl = getUrlResp.data.attributes.url;
        const form = new FormData();
        form.append('files', req.file.buffer, req.file.originalname);
        await axios.post(`${uploadUrl}&directory=${encodeURIComponent(defaultDir)}`, form, {
            headers: { ...form.getHeaders() }
        });
        b.pushLog(`✅ 翼龙文件同步成功`, 'text-emerald-400 font-bold');
        res.json({ success: true });
    } catch (err) {
        b.pushLog(`❌ 翼龙同步失败: ${err.message}`, 'text-red-500');
        res.status(500).json({ success: false });
    }
});
app.get("/api/system/status", (req, res) => res.json(getMemoryStatus()));
app.get("/api/bots", (req, res) => res.json({
    bots: Array.from(activeBots.values()).map(b => ({
        id: b.id,
        serverName: b.serverName,
        username: b.username,
        host: b.targetHost,
        port: b.targetPort,
        status: b.status,
        logs: b.logs,
        settings: b.settings,
        nextRestart: b.settings.restartInterval > 0 ? new Date(b.lastRestartTick + b.settings.restartInterval * 60000).toLocaleTimeString() : '未开启'
    }))
}));
app.post("/api/bots", (req, res) => {
    createSmartBot('bot_' + Math.random().toString(36).substr(2, 7), req.body.host, 25565, req.body.username, [], null, req.body.serverName);
    res.json({ success: true });
});
app.post("/api/bots/:id/set-timer", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b) {
        const val = parseFloat(req.body.value) || 0;
        b.settings.restartInterval = req.body.unit === 'hour' ? Math.round(val * 60) : Math.round(val);
        b.lastRestartTick = Date.now();
        b.pushLog(`⏰ 设定: 每 ${val}${req.body.unit === 'hour' ? '小时' : '分钟'} 重启`, 'text-cyan-400 font-bold');
        saveBotsConfig();
        res.json({ success: true });
    }
});
app.post("/api/bots/:id/pto-config", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b) {
        b.settings.pterodactyl = {
            ...b.settings.pterodactyl,
            url: (req.body.url || "").replace(/\/$/, ""),
            key: req.body.key || "",
            id: req.body.id || "",
            defaultDir: req.body.defaultDir || '/'
        };
        b.pushLog(`🔑 翼龙凭据已更新`, 'text-purple-400');
        saveBotsConfig();
        res.json({ success: true });
    }
});
app.post("/api/bots/:id/toggle-guard", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b) {
        b.settings.pterodactyl.guard = !b.settings.pterodactyl.guard;
        const status = b.settings.pterodactyl.guard ? '开启' : '关闭';
        b.pushLog(`🛡️ 翼龙守护已${status}`, b.settings.pterodactyl.guard ? 'text-blue-400' : 'text-slate-400');
        saveBotsConfig();
        res.json({ success: true });
    }
});
app.delete("/api/bots/:id", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b) {
        if (b.afkTimer) clearInterval(b.afkTimer);
        if (b.instance) b.instance.end();
        activeBots.delete(req.params.id);
        retryCountMap.delete(req.params.id);
        saveBotsConfig();
    }
    res.json({ success: true });
});

// --- [ 6. 翼龙守护核心逻辑 ] ---
setInterval(async () => {
    for (const [id, botMeta] of activeBots.entries()) {
        if (botMeta.settings.pterodactyl.guard && botMeta.settings.pterodactyl.url && botMeta.settings.pterodactyl.key && botMeta.settings.pterodactyl.id) {
            try {
                const { url, key, id: sid } = botMeta.settings.pterodactyl;
                const r = await axios.get(`${url}/api/client/servers/${sid}/resources`, {
                    headers: { 'Authorization': `Bearer ${key}` },
                    timeout: 5000
                });
                const state = r.data.attributes.current_state;
                if (state !== 'running' && state !== 'starting') {
                    botMeta.pushLog(`🛡️ 守护触发: 服务器 [${state}], 正在发送开机指令...`, 'text-yellow-500 font-bold');
                    await axios.post(`${url}/api/client/servers/${sid}/power`, { signal: 'start' }, {
                        headers: { 'Authorization': `Bearer ${key}` }
                    });
                }
            } catch (err) {
                // 静默失败
            }
        }
    }
}, 3 * 60 * 1000);

// --- [ 7. 前端 UI 面板 ] ---
app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pathfinder PRO 2025</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #030712; color: #e2e8f0; background-image: radial-gradient(at 0% 0%, rgba(16, 185, 129, 0.08) 0px, transparent 50%), radial-gradient(at 100% 0%, rgba(59, 130, 246, 0.08) 0px, transparent 50%), radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.08) 0px, transparent 50%); min-height: 100vh; }
        .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.2); }
        .status-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; } .online { background: #10b981; box-shadow: 0 0 6px #10b981; } .offline { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
        .input-dark { background: rgba(2, 6, 23, 0.8); border: 1px solid rgba(255, 255, 255, 0.1); transition: all 0.2s; } .input-dark:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3); outline: none; }
        .btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); transition: all 0.2s; } .btn-primary:hover { box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4); }
        .log-box::-webkit-scrollbar { width: 4px; } .log-box::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); border-radius: 10px; } .log-box::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        .toggle-btn { transition: all 0.2s ease; border: 1px solid transparent; cursor: pointer; font-size: 11px; padding: 3px 10px; border-radius: 8px; font-weight: 700; } .toggle-btn:active { transform: scale(0.95); } .toggle-btn.off { background: rgba(30, 41, 59, 0.8); border-color: rgba(255,255,255,0.05); color: #94a3b8; } .toggle-btn.off:hover { background: rgba(51, 65, 85, 0.8); }
        .toggle-btn.on { background: rgba(59, 130, 246, 0.25); border-color: rgba(59, 130, 246, 0.4); color: #93c5fd; }
        .bot-row { border-bottom: 1px solid rgba(255,255,255,0.04); } .bot-row:last-child { border-bottom: none; }
        .bot-detail { display: none; } .bot-detail.open { display: block; }
        .tab-btn { transition: all 0.2s ease; cursor: pointer; }
        .tab-btn.active { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3); }
        .tab-btn:not(.active) { background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(255,255,255,0.05); color: #94a3b8; }
        .tab-btn:not(.active):hover { background: rgba(51, 65, 85, 0.8); color: #e2e8f0; }
        .view-panel { display: none; } .view-panel.active { display: block; animation: fadeIn 0.2s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body class="p-4 md:p-8 pb-24">
    <div class="max-w-7xl mx-auto">
        <header class="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
            <div class="flex items-center gap-6">
                <div><h1 class="text-3xl md:text-4xl font-black bg-gradient-to-r from-blue-400 via-emerald-400 to-purple-400 bg-clip-text text-transparent uppercase tracking-tighter">Pathfinder PRO</h1><p class="text-slate-500 text-xs mt-1 font-medium tracking-wide">Minecraft 拟人挂机系统 v2025</p></div>
                <form method="POST" action="/logout"><button class="glass border border-white/10 px-4 py-2 rounded-2xl text-xs font-bold text-slate-300 hover:text-white hover:border-white/20 transition-all flex items-center gap-2 shadow-lg" type="submit">退出登录</button></form>
            </div>
            <div class="flex gap-2">
                <button id="tab-bots" class="tab-btn active px-6 py-2.5 rounded-xl text-sm font-bold" onclick="switchTab('bots')">🤖 假人管理</button>
                <button id="tab-pto" class="tab-btn px-6 py-2.5 rounded-xl text-sm font-bold" onclick="switchTab('pto')">🦖 翼龙同步</button>
            </div>
        </header>

        <!-- 假人管理视图 -->
        <div id="view-bots" class="view-panel active">
            <div class="glass p-3 rounded-2xl grid grid-cols-1 md:grid-cols-[1.5fr_2fr_1fr_auto] gap-2 w-full mb-4 border border-white/10 items-center">
                <input id="n" placeholder="服务器名称" class="input-dark rounded-xl px-4 py-2.5 text-sm text-white w-full">
                <input id="h" placeholder="IP:PORT" class="input-dark rounded-xl px-4 py-2.5 text-sm text-white w-full">
                <input id="u" placeholder="角色名" class="input-dark rounded-xl px-4 py-2.5 text-sm text-white w-full">
                <button onclick="addBot()" class="btn-primary text-white px-6 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap">部署角色</button>
            </div>
            <div class="glass rounded-2xl overflow-hidden border border-white/10">
                <div class="grid grid-cols-[1fr_1fr_1fr_1fr_60px] gap-2 px-4 py-2 bg-slate-900/80 text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-white/5">
                    <span class="text-center">名称</span><span class="text-center">状态</span><span class="text-center">角色</span><span class="text-center">地址</span><span></span>
                </div>
                <div id="list"></div>
            </div>
        </div>

        <!-- 翼龙同步视图 -->
        <div id="view-pto" class="view-panel">
            <div class="glass rounded-2xl p-4 md:p-6 border border-white/10">
                <div class="flex items-center justify-between mb-4">
                    <h2 class="text-lg font-extrabold tracking-tight">🦖 翼龙面板同步管理</h2>
                    <span id="pto-count" class="text-xs text-slate-500">0 个机器人已配置翼龙</span>
                </div>
                <div id="pto-list" class="space-y-4">
                    <div class="text-center text-slate-500 text-xs py-8">暂无机器人，请先在假人管理部署角色</div>
                </div>
            </div>
        </div>
    </div>
    <div id="mem-bar" class="fixed bottom-6 right-6 p-4 glass rounded-2xl flex items-center gap-4 z-40 shadow-2xl border border-white/10"><div class="flex flex-col items-center justify-center"><span id="mem-percent" class="text-xl font-black text-white tracking-tight">0.0%</span><span class="text-[9px] font-bold text-slate-500 uppercase tracking-widest">RAM</span></div><div class="w-28 h-2 bg-slate-800 rounded-full overflow-hidden shadow-inner"><div id="mem-progress" class="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700 rounded-full" style="width: 0%"></div></div></div>

    <script>
        // ===== Tab 切换 =====
        function switchTab(tab) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.view-panel').forEach(v => v.classList.remove('active'));
            document.getElementById('tab-' + tab).classList.add('active');
            document.getElementById('view-' + tab).classList.add('active');
            if (tab === 'pto') renderPtoList();
        }

        // ===== 假人管理 =====
        let drafts = {}; function saveDraft(botId, field, val) { if (!drafts[botId]) drafts[botId] = {}; drafts[botId][field] = val; } function getDraft(botId, field, fallback) { return (drafts[botId] && drafts[botId][field] !== undefined) ? drafts[botId][field] : (fallback || ''); }

        async function updateSystemStatus() { try { const r = await fetch('/api/system/status'); const d = await r.json(); document.getElementById('mem-percent').innerText = d.percent + '%'; document.getElementById('mem-progress').style.width = d.percent + '%'; const prog = document.getElementById('mem-progress'); if(parseFloat(d.percent) > 80) prog.className = "h-full bg-gradient-to-r from-red-500 to-orange-400 transition-all duration-700 rounded-full"; else prog.className = "h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700 rounded-full"; } catch(e){} }
        async function addBot() { await fetch('/api/bots', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ serverName: document.getElementById('n').value, host: document.getElementById('h').value, username: document.getElementById('u').value })}); updateUI(true); }
        async function restartNow(id) { await fetch('/api/bots/'+id+'/restart-now', { method: 'POST' }); updateUI(true); }
        async function setTimer(id, value, unit) { await fetch('/api/bots/'+id+'/set-timer', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ value, unit })}); updateUI(true); }
        async function toggle(id, type) { await fetch('/api/bots/'+id+'/toggle', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ type })}); updateUI(true); }
        async function removeBot(id) { if(confirm('确认移除？')) { await fetch('/api/bots/'+id, { method: 'DELETE' }); updateUI(true); } }

        async function updateUI(force = false) {
            if (!force && document.activeElement && document.activeElement.tagName === 'INPUT') return;
            const savedOpenId = openDetailId;
            const r = await fetch('/api/bots'); const d = await r.json();
            document.getElementById('list').innerHTML = d.bots.map(b => {
                const on = b.status === '在线';
                return \`<div class="bot-row">
                    <div class="grid grid-cols-[1fr_1fr_1fr_1fr_60px] gap-2 px-4 py-2.5 items-center cursor-pointer hover:bg-white/[0.02]" onclick="toggleDetail('\${b.id}')">
                        <span class="text-sm \${openDetailId==='\${b.id}'?'text-cyan-300':'text-slate-200'} font-bold truncate text-center">\${b.serverName || b.username}</span>
                        <span class="text-xs \${on?'text-emerald-400':'text-red-400'} font-semibold text-center flex items-center justify-center gap-1.5"><span class="status-dot \${on?'online':'offline'}"></span>\${b.status}</span>
                        <span class="text-xs text-slate-400 truncate text-center">\${b.username}</span>
                        <span class="text-xs text-slate-500 truncate font-mono text-center">\${b.host}:\${b.port}</span>
                        <button onclick="event.stopPropagation(); removeBot('\${b.id}')" class="text-xs text-slate-600 hover:text-red-400 transition-colors text-center">✕</button>
                    </div>
                    <div class="bot-detail" id="detail-\${b.id}">
                        <div class="px-4 pb-3 space-y-3">
                            <div class="log-box bg-black/50 rounded-xl p-3 h-28 overflow-y-auto font-mono text-[10px] border border-white/5">\${b.logs.map(l => \`<div class="mb-1 \${l.color} flex"><span class="opacity-30 mr-1.5 shrink-0 select-none">[\${l.time}]</span><span>\${l.msg}</span></div>\`).join('')}</div>
                            <div class="flex flex-wrap gap-1.5 items-center">
                                <button onclick="toggle('\${b.id}','ai')" class="toggle-btn \${b.settings.ai?'on':'off'}">👁️ AI</button>
                                <button onclick="toggle('\${b.id}','walk')" class="toggle-btn \${b.settings.walk?'on':'off'}">👣 巡逻</button>
                                <button onclick="toggle('\${b.id}','chat')" class="toggle-btn \${b.settings.chat?'on':'off'}">💬 喊话</button>
                                <span class="text-[10px] text-slate-600 ml-2">下次重启: \${b.nextRestart}</span>
                            </div>
                            <div class="flex flex-wrap gap-2 items-center">
                                <span class="text-[10px] text-slate-500 font-bold">定时重启</span>
                                <input id="rmin-\${b.id}" type="number" step="0.1" placeholder="分钟" class="input-dark rounded-lg px-2 py-1 text-xs w-20">
                                <button onclick="setTimer('\${b.id}', document.getElementById('rmin-\${b.id}').value, 'min')" class="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-lg text-[10px] font-bold">分钟</button>
                                <input id="rhour-\${b.id}" type="number" step="0.1" placeholder="小时" class="input-dark rounded-lg px-2 py-1 text-xs w-20">
                                <button onclick="setTimer('\${b.id}', document.getElementById('rhour-\${b.id}').value, 'hour')" class="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-lg text-[10px] font-bold">小时</button>
                                <button onclick="restartNow('\${b.id}')" class="bg-red-500/20 text-red-400 px-3 py-1 rounded-lg text-[10px] font-bold hover:bg-red-500 hover:text-white">⚡ 立即重启</button>
                            </div>
                        </div>
                    </div>
                </div>\`;
            }).join('');
            if (savedOpenId && document.getElementById('detail-' + savedOpenId)) {
                openDetailId = savedOpenId;
                document.getElementById('detail-' + savedOpenId).classList.add('open');
            }
        }
        let openDetailId = null;
        function toggleDetail(id) {
            const el = document.getElementById('detail-' + id);
            if (!el) return;
            if (openDetailId === id) {
                el.classList.remove('open');
                openDetailId = null;
            } else {
                if (openDetailId) {
                    const prev = document.getElementById('detail-' + openDetailId);
                    if (prev) prev.classList.remove('open');
                }
                el.classList.add('open');
                openDetailId = id;
            }
        }

        // ===== 翼龙同步管理 =====
        async function savePto(id) {
            const data = {
                url: document.getElementById('pto-url-'+id).value,
                id: document.getElementById('pto-sid-'+id).value,
                key: document.getElementById('pto-key-'+id).value,
                defaultDir: document.getElementById('pto-ddir-'+id).value
            };
            await fetch('/api/bots/'+id+'/pto-config', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
            renderPtoList();
        }
        async function toggleGuard(id) {
            await fetch('/api/bots/'+id+'/toggle-guard', { method: 'POST' });
            renderPtoList();
        }
        async function uploadPtoFile(id) {
            const input = document.getElementById('pto-file-'+id);
            if (!input.files[0]) return;
            const fd = new FormData();
            fd.append('file', input.files[0]);
            const res = await fetch('/api/bots/'+id+'/upload', { method: 'POST', body: fd });
            alert(res.ok ? '✅ 同步成功' : '❌ 同步失败');
            input.value = '';
        }
        async function renderPtoList() {
            const r = await fetch('/api/bots'); const d = await r.json();
            const configured = d.bots.filter(b => b.settings.pterodactyl?.url || b.settings.pterodactyl?.key);
            document.getElementById('pto-count').textContent = configured.length + ' / ' + d.bots.length + ' 个机器人已配置翼龙';
            const el = document.getElementById('pto-list');
            if (d.bots.length === 0) {
                el.innerHTML = '<div class="text-center text-slate-500 text-xs py-8">暂无机器人，请先在假人管理部署角色</div>';
                return;
            }
            el.innerHTML = d.bots.map(b => {
                const pto = b.settings.pterodactyl || {};
                const hasPto = pto.url || pto.key;
                return \`<div class="glass rounded-xl p-4 border \${hasPto ? 'border-purple-500/30' : 'border-slate-700/50'}">
                    <div class="flex items-center justify-between mb-3">
                        <div class="flex items-center gap-2.5">
                            <h3 class="text-base font-extrabold tracking-tight">\${b.serverName || b.username}</h3>
                            <span class="text-xs text-slate-500">\${b.host}:\${b.port}</span>
                            <span class="px-2 py-0.5 rounded-full text-[9px] font-bold \${hasPto ? 'bg-purple-500/20 text-purple-400' : 'bg-slate-700 text-slate-500'}">\${hasPto ? '已配置' : '未配置'}</span>
                        </div>
                    </div>
                    <div class="grid gap-2">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <input id="pto-url-\${b.id}" placeholder="面板URL" value="\${pto.url || ''}" class="input-dark rounded-lg px-3 py-2 text-xs">
                            <input id="pto-sid-\${b.id}" placeholder="服务器ID" value="\${pto.id || ''}" class="input-dark rounded-lg px-3 py-2 text-xs">
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <input id="pto-key-\${b.id}" type="password" placeholder="Client API Key" value="\${pto.key || ''}" class="input-dark rounded-lg px-3 py-2 text-xs">
                            <input id="pto-ddir-\${b.id}" placeholder="默认目录 /" value="\${pto.defaultDir || '/'}" class="input-dark rounded-lg px-3 py-2 text-xs">
                        </div>
                        <div class="flex flex-wrap gap-2 mt-1">
                            <button onclick="savePto('\${b.id}')" class="bg-purple-600 hover:bg-purple-500 px-4 py-2 rounded-lg text-[11px] font-bold">💾 保存配置</button>
                            <button onclick="toggleGuard('\${b.id}')" class="\${pto.guard ? 'bg-emerald-600' : 'bg-slate-700'} hover:opacity-80 px-4 py-2 rounded-lg text-[11px] font-bold">🛡️ 守护 \${pto.guard ? '开启' : '关闭'}</button>
                            <label class="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg text-[11px] font-bold cursor-pointer">📤 同步文件<input id="pto-file-\${b.id}" type="file" class="hidden" onchange="uploadPtoFile('\${b.id}')"></label>
                        </div>
                    </div>
                </div>\`;
            }).join('');
        }

        // ===== 初始化 =====
        setInterval(() => { updateUI(false); updateSystemStatus(); }, 3000);
        updateUI(true);
    </script>
</body></html>`);
});

const PORT = process.env.PORT || 8100;
const HOST = process.env.IP || '::';

app.listen(PORT, HOST, () => {
    console.log(`✅ HTTP 服务器已启动: http://[${HOST}]:${PORT}`);
    // 恢复之前保存的机器人配置
    if (fsSync.existsSync(CONFIG_FILE)) {
        try {
            const saved = JSON.parse(fsSync.readFileSync(CONFIG_FILE));
            saved.forEach(b => {
                createSmartBot(
                    'bot_' + Math.random().toString(36).substr(2, 5),
                    b.host,
                    b.port,
                    b.username,
                    b.logs || [],
                    b.settings,
                    b.serverName
                );
            });
        } catch (e) {
            console.error('配置文件读取失败，跳过自动恢复');
        }
    }
});
