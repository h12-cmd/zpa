const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ngg';
const DB_FILE = path.join(__dirname, 'database.json');
const activeClients = new Map();

let dbCache = loadDB();
let writeQueue = Promise.resolve();

function loadDB() {
    if (!fs.existsSync(DB_FILE)) return [];
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
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

function getTimestamp() {
    return new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function addLog(token, message) {
    const db = [...dbCache];
    const index = db.findIndex(item => item.token === token);
    if (index === -1) return;

    const logEntry = `[${getTimestamp()}] ${message}`;
    const currentLogs = Array.isArray(db[index].logs) ? [...db[index].logs] : [];
    currentLogs.unshift(logEntry);
    if (currentLogs.length > 10) currentLogs.pop();

    db[index] = { ...db[index], logs: currentLogs };
    saveDB(db);
}

function addChatLog(token, chatMsg) {
    const db = [...dbCache];
    const index = db.findIndex(item => item.token === token);
    if (index === -1) return;

    const entry = `[${getTimestamp()}] ${chatMsg}`;
    const currentChat = Array.isArray(db[index].chatLogs) ? [...db[index].chatLogs] : [];
    currentChat.unshift(entry);
    if (currentChat.length > 25) currentChat.pop();

    db[index] = { ...db[index], chatLogs: currentChat };
    saveDB(db);
}

function cleanupSession(token) {
    const existing = activeClients.get(token);
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

    activeClients.delete(token);
}

function attachVoiceListeners(token, connection, channelId, selfMute, selfDeaf) {
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

            const current = dbCache.find(item => item.token === token);
            if (current && activeClients.has(token)) {
                addLog(token, 'Mất kết nối Voice, đang thử kết nối lại...');
                connectVoice({
                    ...current,
                    channelId: channelId || current.channelId,
                    selfMute: typeof selfMute === 'boolean' ? selfMute : current.selfMute,
                    selfDeaf: typeof selfDeaf === 'boolean' ? selfDeaf : current.selfDeaf
                });
            }
        }
    });
}

async function connectVoice(config) {
    const { token, channelId, selfMute, selfDeaf, textChannelId } = config;
    if (!token || !channelId) return;

    cleanupSession(token);

    // Đảm bảo bản ghi tồn tại sớm để addLog/addChatLog có thể ghi nhận
    const existingDb = [...dbCache];
    const existingIdx = existingDb.findIndex(item => item.token === token);
    if (existingIdx === -1) {
        existingDb.push({
            token,
            channelId,
            selfMute: Boolean(selfMute),
            selfDeaf: Boolean(selfDeaf),
            textChannelId: textChannelId || '',
            userId: '',
            username: '',
            connectedAt: null,
            logs: [],
            chatLogs: []
        });
        saveDB(existingDb);
    }

    const client = new Client({
        checkUpdate: false,
        sweepers: { messages: { interval: 120, lifetime: 60 } }
    });

    activeClients.set(token, {
        client,
        connection: null,
        connectedAt: Date.now()
    });

    client.once('ready', async () => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isVoice()) {
                addLog(token, 'Lỗi: ID kênh thoại không hợp lệ!');
                cleanupSession(token);
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
                selfMute: Boolean(selfMute),
                selfDeaf: Boolean(selfDeaf),
            });

            attachVoiceListeners(token, connection, channel.id, Boolean(selfMute), Boolean(selfDeaf));
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

            const connectedAt = Date.now();
            activeClients.set(token, {
                client,
                connection,
                connectedAt
            });

            const db = [...dbCache];
            const index = db.findIndex(item => item.token === token);
            const accountData = {
                token,
                channelId: channel.id,
                selfMute: Boolean(selfMute),
                selfDeaf: Boolean(selfDeaf),
                textChannelId: textChannelId ?? (index !== -1 ? db[index].textChannelId || '' : ''),
                userId: client.user.id,
                username: client.user.tag,
                connectedAt,
                logs: index !== -1 && Array.isArray(db[index].logs) ? db[index].logs : [],
                chatLogs: index !== -1 && Array.isArray(db[index].chatLogs) ? db[index].chatLogs : []
            };

            if (index !== -1) db[index] = accountData;
            else db.push(accountData);
            saveDB(db);

            addLog(token, `Thành công: Đã kết nối vào Voice [${channel.name}]`);
        } catch (err) {
            addLog(token, `Lỗi kết nối: ${err.message}`);
        }
    });

    client.on('messageCreate', (message) => {
        const account = dbCache.find(item => item.token === token);
        if (account && account.textChannelId && message.channel && message.channel.id === account.textChannelId) {
            const sender = message.author ? message.author.tag : 'Unknown';
            const content = message.content || '[Tệp/Sticker/Hình ảnh]';
            addChatLog(token, `${sender}: ${content}`);
        }
    });

    try {
        await client.login(token);
    } catch (err) {
        addLog(token, `Lỗi đăng nhập: Token hỏng hoặc đổi pass (${err.message})`);
        cleanupSession(token);
    }
}

function restoreAllSessions() {
    const db = [...dbCache];
    db.forEach((config, i) => {
        setTimeout(() => connectVoice(config), i * 1200);
    });
}

// ==========================================
// ROUTES GIAO DIỆN (CHUYỂN TRANG)
// ==========================================
app.get('/check', (req, res) => res.sendFile(path.join(__dirname, 'public', 'check.html')));
app.get('/taikhoan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'taikhoan.html')));
app.get('/setting', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setting.html')));
app.get('/dt', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dt.html')));

// ==========================================
// API TRUY VẤN & XỬ LÝ
// ==========================================
app.get('/api/status', (req, res) => {
    const onlineList = [];

    dbCache.forEach(item => {
        const active = activeClients.get(item.token);
        if (active && active.client && active.client.isReady()) {
            const name = item.username || 'User';
            const hiddenName = name.length > 4 ? name.substring(0, 3) + '***' : 'User***';

            onlineList.push({
                name: hiddenName,
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
    if (!token || !channelId) {
        return res.status(400).json({ success: false, message: 'Thiếu Token hoặc ID Kênh!' });
    }

    connectVoice({ token, channelId, selfMute, selfDeaf });
    return res.json({
        success: true,
        message: 'Đã kết nối',
        settingUrl: `/setting?token=${encodeURIComponent(token)}`
    });
});

app.post('/api/user/get-settings', (req, res) => {
    const { token } = req.body;
    const account = dbCache.find(item => item.token === token);
    if (!account) {
        return res.status(404).json({ success: false, message: 'Tài khoản chưa kết nối!' });
    }

    const active = activeClients.get(token);
    res.json({
        success: true,
        data: {
            username: account.username,
            userId: account.userId,
            channelId: account.channelId,
            selfMute: account.selfMute,
            selfDeaf: account.selfDeaf,
            textChannelId: account.textChannelId || '',
            isOnline: Boolean(active && active.client && active.client.isReady()),
            logs: account.logs || [],
            chatLogs: account.chatLogs || []
        }
    });
});

app.post('/api/user/update-settings', (req, res) => {
    const { token, channelId, selfMute, selfDeaf, textChannelId } = req.body;

    const db = [...dbCache];
    const index = db.findIndex(item => item.token === token);
    if (index === -1) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    }

    const updatedConfig = {
        ...db[index],
        channelId,
        selfMute: Boolean(selfMute),
        selfDeaf: Boolean(selfDeaf),
        textChannelId: textChannelId || ''
    };

    db[index] = updatedConfig;
    saveDB(db);

    connectVoice(updatedConfig);
    res.json({ success: true, message: 'Đã lưu cấu hình!' });
});

app.post('/api/user/send-message', async (req, res) => {
    const { token, message } = req.body;
    const account = dbCache.find(item => item.token === token);

    if (!account || !account.textChannelId) {
        return res.status(400).json({ success: false, message: 'Chưa cài đặt ID Kênh Chat!' });
    }

    const active = activeClients.get(token);
    if (!active || !active.client || !active.client.isReady()) {
        return res.status(400).json({ success: false, message: 'Tài khoản đang Offline!' });
    }

    try {
        const channel = await active.client.channels.fetch(account.textChannelId);
        if (channel && channel.isText()) {
            await channel.send(message);
            addChatLog(token, `[Bạn gửi]: ${message}`);
            return res.json({ success: true, message: 'Đã gửi tin nhắn!' });
        }

        addChatLog(token, `[Lỗi Gửi]: ID Kênh không phải kênh chat văn bản!`);
        return res.status(400).json({ success: false, message: 'Kênh không hợp lệ!' });
    } catch (err) {
        addChatLog(token, `[Lỗi Gửi]: ${err.message}`);
        return res.status(500).json({ success: false, message: `Lỗi: ${err.message}` });
    }
});

app.post('/api/disconnect', (req, res) => {
    const { token } = req.body;
    const existsInDb = dbCache.some(item => item.token === token);

    if (activeClients.has(token) || existsInDb) {
        cleanupSession(token);
        const filtered = dbCache.filter(item => item.token !== token);
        saveDB(filtered);
        return res.json({ success: true, message: 'Đã ngắt kết nối' });
    }

    return res.status(400).json({ success: false, message: 'Tài khoản chưa kết nối!' });
});

app.post('/api/accounts-management', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Sai mật khẩu Admin!' });
    }

    const list = dbCache.map(item => {
        const active = activeClients.get(item.token);
        const isOnline = Boolean(active && active.client && active.client.isReady());
        return {
            userId: item.userId || 'Chưa xác định',
            username: item.username || 'Chưa xác định',
            token: item.token,
            isOnline,
            connectedAt: isOnline ? active.connectedAt : null,
            logs: item.logs || []
        };
    });

    res.json({ success: true, total: list.length, accounts: list });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
    restoreAllSessions();
});
