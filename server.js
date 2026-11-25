require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Client } = require('discord.js-selfbot-v13');
const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ngg';
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'default-zpa-secret-key-please-change';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();

const DB_FILE = path.join(__dirname, 'database.json');
const activeClients = new Map();     // sessionId -> { client, connection, connectedAt, guildName, channelName, reconnectCount }
const adminSessions = new Map();     // adminToken -> expiresAt
const sseClients = new Map();        // sessionId -> Set<res>

// ==========================================
// MÃ HÓA & TIỆN ÍCH BẢO MẬT
// ==========================================
function encryptToken(plainToken) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptToken(stored) {
    if (!stored || typeof stored !== 'string') return '';
    if (!stored.includes(':')) return stored; // Tương thích ngược nếu DB cũ chưa mã hóa
    try {
        const [ivHex, tagHex, dataHex] = stored.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (e) {
        return '';
    }
}

function hashToken(plainToken) {
    return crypto.createHash('sha256').update(plainToken).digest('hex');
}

function generateId(bytes = 16) {
    return crypto.randomBytes(bytes).toString('hex');
}

function getTimestamp() {
    return new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// ==========================================
// QUẢN LÝ DATABASE (CÓ HÀNG ĐỢI GHI AN TOÀN)
// ==========================================
let dbCache = loadDB();
let writeQueue = Promise.resolve();

function loadDB() {
    if (!fs.existsSync(DB_FILE)) return [];
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Di trú tự động các bản ghi cũ sang định dạng mới
        return parsed.map(item => {
            const plain = item.encryptedToken ? decryptToken(item.encryptedToken) : (item.token || '');
            return {
                sessionId: item.sessionId || generateId(12),
                tokenHash: item.tokenHash || (plain ? hashToken(plain) : ''),
                encryptedToken: item.encryptedToken || (plain ? encryptToken(plain) : ''),
                channelId: item.channelId || '',
                selfMute: Boolean(item.selfMute),
                selfDeaf: Boolean(item.selfDeaf),
                textChannelId: item.textChannelId || '',
                userId: item.userId || '',
                username: item.username || '',
                guildName: item.guildName || '',
                channelName: item.channelName || '',
                reconnectCount: item.reconnectCount || 0,
                authFailed: Boolean(item.authFailed),
                logs: Array.isArray(item.logs) ? item.logs : [],
                chatLogs: Array.isArray(item.chatLogs) ? item.chatLogs : []
            };
        });
    } catch (e) {
        return [];
    }
}

function saveDB(data) {
    dbCache = data;
    const snapshot = JSON.stringify(data, null, 2);
    writeQueue = writeQueue
        .then(() => fs.promises.writeFile(DB_FILE, snapshot, 'utf8'))
        .catch(() => {});
}

// ==========================================
// REALTIME SSE PUSH TỚI TRANG /SETTING
// ==========================================
function pushRealtimeUpdate(sessionId, payload) {
    const clients = sseClients.get(sessionId);
    if (!clients || clients.size === 0) return;
    const dataStr = `data: ${JSON.stringify(payload)}\n\n`;
    clients.forEach(res => {
        try {
            res.write(dataStr);
        } catch (e) {}
    });
}

function addLog(sessionId, message) {
    const db = [...dbCache];
    const index = db.findIndex(item => item.sessionId === sessionId);
    if (index === -1) return;

    const logEntry = `[${getTimestamp()}] ${message}`;
    const currentLogs = [...(db[index].logs || [])];
    currentLogs.unshift(logEntry);
    if (currentLogs.length > 20) currentLogs.pop();

    db[index] = { ...db[index], logs: currentLogs };
    saveDB(db);
    pushRealtimeUpdate(sessionId, { type: 'log', logs: currentLogs });
}

function addChatLog(sessionId, chatMsg) {
    const db = [...dbCache];
    const index = db.findIndex(item => item.sessionId === sessionId);
    if (index === -1) return;

    const entry = `[${getTimestamp()}] ${chatMsg}`;
    const currentChat = [...(db[index].chatLogs || [])];
    currentChat.unshift(entry);
    if (currentChat.length > 40) currentChat.pop();

    db[index] = { ...db[index], chatLogs: currentChat };
    saveDB(db);
    pushRealtimeUpdate(sessionId, { type: 'chat', chatLogs: currentChat });
}

// ==========================================
// KẾT NỐI VOICE & TỰ ĐỘNG KHÔI PHỤC
// ==========================================
function cleanupSession(sessionId) {
    const existing = activeClients.get(sessionId);
    if (!existing) return;

    try {
        if (existing.connection && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            existing.connection.destroy();
        }
    } catch (e) {}

    try {
        if (existing.client) {
            existing.client.removeAllListeners();
            existing.client.destroy();
        }
    } catch (e) {}

    activeClients.delete(sessionId);
}

function attachVoiceListeners(sessionId, connection) {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch (err) {
            try {
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            } catch (e) {}

            const account = dbCache.find(item => item.sessionId === sessionId);
            if (account && !account.authFailed && activeClients.has(sessionId)) {
                const db = [...dbCache];
                const idx = db.findIndex(item => item.sessionId === sessionId);
                if (idx !== -1) {
                    db[idx] = { ...db[idx], reconnectCount: (db[idx].reconnectCount || 0) + 1 };
                    saveDB(db);
                }
                addLog(sessionId, 'Mất kết nối Voice, đang tự động kết nối lại...');
                connectVoice(sessionId);
            }
        }
    });
}

async function connectVoice(sessionId) {
    const account = dbCache.find(item => item.sessionId === sessionId);
    if (!account) return;

    const plainToken = decryptToken(account.encryptedToken);
    if (!plainToken) {
        addLog(sessionId, 'Lỗi: Không thể giải mã Token (kiểm tra ENCRYPTION_SECRET).');
        return;
    }

    cleanupSession(sessionId);

    const client = new Client({
        checkUpdate: false,
        sweepers: { messages: { interval: 120, lifetime: 60 } }
    });

    activeClients.set(sessionId, {
        client,
        connection: null,
        connectedAt: Date.now()
    });

    client.once('ready', async () => {
        try {
            const channel = await client.channels.fetch(account.channelId);
            if (!channel || !channel.isVoice()) {
                addLog(sessionId, 'Lỗi: ID kênh thoại không hợp lệ hoặc không có quyền truy cập!');
                cleanupSession(sessionId);
                pushRealtimeUpdate(sessionId, { type: 'status', isOnline: false });
                return;
            }

            const existingConn = getVoiceConnection(channel.guild.id);
            if (existingConn && existingConn.state.status !== VoiceConnectionStatus.Destroyed) {
                existingConn.destroy();
            }

            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfMute: Boolean(account.selfMute),
                selfDeaf: Boolean(account.selfDeaf),
            });

            attachVoiceListeners(sessionId, connection);
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

            const connectedAt = Date.now();
            const guildName = channel.guild ? channel.guild.name : 'Unknown Server';
            const channelName = channel.name || 'Voice Channel';

            activeClients.set(sessionId, {
                client,
                connection,
                connectedAt,
                guildName,
                channelName
            });

            const db = [...dbCache];
            const index = db.findIndex(item => item.sessionId === sessionId);
            if (index !== -1) {
                db[index] = {
                    ...db[index],
                    userId: client.user.id,
                    username: client.user.tag,
                    guildName,
                    channelName,
                    authFailed: false
                };
                saveDB(db);
            }

            addLog(sessionId, `Thành công: Đã vào [${guildName} / ${channelName}]`);
            pushRealtimeUpdate(sessionId, {
                type: 'status',
                isOnline: true,
                username: client.user.tag,
                userId: client.user.id,
                guildName,
                channelName
            });
        } catch (err) {
            addLog(sessionId, `Lỗi kết nối Voice: ${err.message}`);
            pushRealtimeUpdate(sessionId, { type: 'status', isOnline: false });
        }
    });

    client.on('messageCreate', (message) => {
        const current = dbCache.find(item => item.sessionId === sessionId);
        if (current && current.textChannelId && message.channel && message.channel.id === current.textChannelId) {
            const sender = message.author ? message.author.tag : 'Unknown';
            const content = message.content || '[Tệp/Sticker/Hình ảnh]';
            addChatLog(sessionId, `${sender}: ${content}`);
        }
    });

    try {
        await client.login(plainToken);
    } catch (err) {
        const db = [...dbCache];
        const index = db.findIndex(item => item.sessionId === sessionId);
        if (index !== -1) {
            db[index] = { ...db[index], authFailed: true };
            saveDB(db);
        }
        addLog(sessionId, `Lỗi đăng nhập (Token hỏng/đổi mật khẩu - đã dừng tự thử lại): ${err.message}`);
        cleanupSession(sessionId);
        pushRealtimeUpdate(sessionId, { type: 'status', isOnline: false });
    }
}

function restoreAllSessions() {
    const validAccounts = dbCache.filter(item => !item.authFailed);
    validAccounts.forEach((acc, i) => {
        setTimeout(() => connectVoice(acc.sessionId), i * 1200);
    });
}

// ==========================================
// MIDDLEWARE XÁC THỰC ADMIN
// ==========================================
function requireAdmin(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const adminToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body && req.body.adminToken);
    const legacyPass = req.body && req.body.password;

    if (legacyPass && legacyPass === ADMIN_PASSWORD) {
        return next();
    }

    if (adminToken && adminSessions.has(adminToken)) {
        const expiresAt = adminSessions.get(adminToken);
        if (Date.now() < expiresAt) {
            return next();
        }
        adminSessions.delete(adminToken);
    }

    return res.status(401).json({ success: false, message: 'Phiên Admin hết hạn hoặc không hợp lệ!' });
}

// ==========================================
// ROUTES GIAO DIỆN
// ==========================================
app.get('/check', (req, res) => res.sendFile(path.join(__dirname, 'public', 'check.html')));
app.get('/taikhoan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'taikhoan.html')));
app.get('/setting', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setting.html')));
app.get('/dt', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ==========================================
// API CÔNG KHAI & NGƯỜI DÙNG
// ==========================================
app.get('/api/status', (req, res) => {
    const onlineList = [];

    dbCache.forEach(item => {
        const active = activeClients.get(item.sessionId);
        if (active && active.client && active.client.isReady()) {
            const name = item.username || 'User';
            const hiddenName = name.length > 4 ? name.substring(0, 3) + '***' : 'User***';
            onlineList.push({
                name: hiddenName,
                server: active.guildName || item.guildName || 'Discord Server',
                connectedAt: active.connectedAt
            });
        }
    });

    res.json({
        total: onlineList.length,
        accounts: onlineList
    });
});

app.post('/api/connect', (req, res) => {
    const { token, channelId, selfMute, selfDeaf } = req.body;
    const cleanToken = (token || '').trim();
    const cleanChannel = (channelId || '').trim();

    if (!cleanToken || !cleanChannel) {
        return res.status(400).json({ success: false, message: 'Thiếu Token hoặc ID Kênh Thoại!' });
    }

    const tHash = hashToken(cleanToken);
    const db = [...dbCache];
    let index = db.findIndex(item => item.tokenHash === tHash);
    let sessionId;

    if (index !== -1) {
        sessionId = db[index].sessionId;
        db[index] = {
            ...db[index],
            encryptedToken: encryptToken(cleanToken),
            channelId: cleanChannel,
            selfMute: Boolean(selfMute),
            selfDeaf: Boolean(selfDeaf),
            authFailed: false
        };
    } else {
        sessionId = generateId(12);
        db.push({
            sessionId,
            tokenHash: tHash,
            encryptedToken: encryptToken(cleanToken),
            channelId: cleanChannel,
            selfMute: Boolean(selfMute),
            selfDeaf: Boolean(selfDeaf),
            textChannelId: '',
            userId: '',
            username: '',
            guildName: '',
            channelName: '',
            reconnectCount: 0,
            authFailed: false,
            logs: [],
            chatLogs: []
        });
    }

    saveDB(db);
    connectVoice(sessionId);

    return res.json({
        success: true,
        message: 'Đang khởi tạo kết nối Voice',
        sessionId,
        settingUrl: `/setting?id=${encodeURIComponent(sessionId)}`
    });
});

// Tìm kiếm session bằng sessionId hoặc Token (tiện cho người dùng quay lại)
function findAccountByQuery({ sessionId, token }) {
    if (sessionId) {
        return dbCache.find(item => item.sessionId === sessionId);
    }
    if (token) {
        const tHash = hashToken(token.trim());
        return dbCache.find(item => item.tokenHash === tHash);
    }
    return null;
}

app.post('/api/user/get-settings', (req, res) => {
    const account = findAccountByQuery(req.body);
    if (!account) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy phiên treo Voice nào!' });
    }

    const active = activeClients.get(account.sessionId);
    const isOnline = Boolean(active && active.client && active.client.isReady());

    res.json({
        success: true,
        data: {
            sessionId: account.sessionId,
            username: account.username || 'Đang tải...',
            userId: account.userId || 'N/A',
            guildName: (active && active.guildName) || account.guildName || '',
            channelName: (active && active.channelName) || account.channelName || '',
            channelId: account.channelId,
            selfMute: account.selfMute,
            selfDeaf: account.selfDeaf,
            textChannelId: account.textChannelId || '',
            reconnectCount: account.reconnectCount || 0,
            isOnline,
            connectedAt: isOnline ? active.connectedAt : null,
            logs: account.logs || [],
            chatLogs: account.chatLogs || []
        }
    });
});

// Stream SSE realtime cho Chat & Logs
app.get('/api/user/stream', (req, res) => {
    const sessionId = req.query.id;
    const account = dbCache.find(item => item.sessionId === sessionId);
    if (!account) return res.status(404).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
    sseClients.get(sessionId).add(res);

    const keepAlive = setInterval(() => {
        res.write(': ping\n\n');
    }, 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        const set = sseClients.get(sessionId);
        if (set) {
            set.delete(res);
            if (set.size === 0) sseClients.delete(sessionId);
        }
    });
});

app.post('/api/user/update-settings', (req, res) => {
    const { sessionId, token, channelId, selfMute, selfDeaf, textChannelId } = req.body;
    const account = findAccountByQuery({ sessionId, token });
    if (!account) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    }

    const db = [...dbCache];
    const index = db.findIndex(item => item.sessionId === account.sessionId);
    db[index] = {
        ...db[index],
        channelId: (channelId || db[index].channelId).trim(),
        selfMute: Boolean(selfMute),
        selfDeaf: Boolean(selfDeaf),
        textChannelId: (textChannelId || '').trim(),
        authFailed: false
    };
    saveDB(db);

    connectVoice(account.sessionId);
    res.json({ success: true, message: 'Đã lưu cấu hình & đang kết nối lại!' });
});

app.post('/api/user/reconnect', (req, res) => {
    const account = findAccountByQuery(req.body);
    if (!account) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy phiên!' });
    }

    const db = [...dbCache];
    const index = db.findIndex(item => item.sessionId === account.sessionId);
    if (index !== -1) {
        db[index] = { ...db[index], authFailed: false };
        saveDB(db);
    }

    addLog(account.sessionId, 'Yêu cầu kết nối lại thủ công...');
    connectVoice(account.sessionId);
    res.json({ success: true, message: 'Đang kết nối lại Voice...' });
});

app.post('/api/user/send-message', async (req, res) => {
    const { sessionId, token, message } = req.body;
    const account = findAccountByQuery({ sessionId, token });

    if (!account || !account.textChannelId) {
        return res.status(400).json({ success: false, message: 'Chưa cài đặt ID Kênh Chat!' });
    }

    const cleanMsg = (message || '').trim();
    if (!cleanMsg) {
        return res.status(400).json({ success: false, message: 'Nội dung tin nhắn trống!' });
    }

    const active = activeClients.get(account.sessionId);
    if (!active || !active.client || !active.client.isReady()) {
        return res.status(400).json({ success: false, message: 'Tài khoản đang Offline!' });
    }

    try {
        const channel = await active.client.channels.fetch(account.textChannelId);
        if (channel && channel.isText()) {
            await channel.send(cleanMsg);
            addChatLog(account.sessionId, `[Bạn gửi]: ${cleanMsg}`);
            return res.json({ success: true, message: 'Đã gửi tin nhắn!' });
        }

        addChatLog(account.sessionId, '[Lỗi Gửi]: ID Kênh không phải kênh chat văn bản!');
        return res.status(400).json({ success: false, message: 'Kênh không hợp lệ!' });
    } catch (err) {
        addChatLog(account.sessionId, `[Lỗi Gửi]: ${err.message}`);
        return res.status(500).json({ success: false, message: `Lỗi: ${err.message}` });
    }
});

app.post('/api/disconnect', (req, res) => {
    const account = findAccountByQuery(req.body);
    if (!account) {
        return res.status(400).json({ success: false, message: 'Tài khoản chưa kết nối!' });
    }

    cleanupSession(account.sessionId);
    const filtered = dbCache.filter(item => item.sessionId !== account.sessionId);
    saveDB(filtered);

    return res.json({ success: true, message: 'Đã ngắt kết nối và xóa phiên!' });
});

// ==========================================
// API QUẢN TRỊ ADMIN
// ==========================================
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (!password || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Sai mật khẩu Admin!' });
    }

    const adminToken = generateId(24);
    adminSessions.set(adminToken, Date.now() + 2 * 60 * 60 * 1000); // Hết hạn sau 2 giờ
    res.json({ success: true, adminToken });
});

app.post('/api/accounts-management', requireAdmin, (req, res) => {
    const list = dbCache.map(item => {
        const active = activeClients.get(item.sessionId);
        const isOnline = Boolean(active && active.client && active.client.isReady());
        return {
            sessionId: item.sessionId,
            userId: item.userId || 'Chưa xác định',
            username: item.username || 'Chưa xác định',
            guildName: (active && active.guildName) || item.guildName || '',
            channelName: (active && active.channelName) || item.channelName || '',
            reconnectCount: item.reconnectCount || 0,
            authFailed: Boolean(item.authFailed),
            token: decryptToken(item.encryptedToken),
            isOnline,
            connectedAt: isOnline ? active.connectedAt : null,
            logs: item.logs || []
        };
    });

    res.json({ success: true, total: list.length, accounts: list });
});

app.post('/api/admin/action', requireAdmin, (req, res) => {
    const { sessionId, action } = req.body;
    const account = dbCache.find(item => item.sessionId === sessionId);
    if (!account) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    }

    if (action === 'reconnect') {
        const db = [...dbCache];
        const idx = db.findIndex(item => item.sessionId === sessionId);
        if (idx !== -1) {
            db[idx] = { ...db[idx], authFailed: false };
            saveDB(db);
        }
        addLog(sessionId, 'Admin kích hoạt kết nối lại.');
        connectVoice(sessionId);
        return res.json({ success: true, message: 'Đã gửi lệnh kết nối lại!' });
    }

    if (action === 'delete') {
        cleanupSession(sessionId);
        saveDB(dbCache.filter(item => item.sessionId !== sessionId));
        return res.json({ success: true, message: 'Đã xóa tài khoản khỏi hệ thống!' });
    }

    return res.status(400).json({ success: false, message: 'Hành động không hợp lệ!' });
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
    restoreAllSessions();
});
