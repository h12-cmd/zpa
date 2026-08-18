const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = 'Ngg'; 
const DB_FILE = path.join(__dirname, 'database.json');
const activeClients = new Map(); // { client, connectedAt, chatTimer }

function loadDB() {
    if (!fs.existsSync(DB_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return []; }
}

function saveDB(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

function addLog(token, message) {
    let db = loadDB();
    const index = db.findIndex(item => item.token === token);
    const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const logEntry = `[${timestamp}] ${message}`;

    if (index !== -1) {
        if (!db[index].logs) db[index].logs = [];
        db[index].logs.unshift(logEntry);
        if (db[index].logs.length > 10) db[index].logs.pop();
        saveDB(db);
    }
}

function stopAutoChat(token) {
    if (activeClients.has(token)) {
        const clientData = activeClients.get(token);
        if (clientData.chatTimer) {
            clearInterval(clientData.chatTimer);
            clientData.chatTimer = null;
        }
    }
}

function startAutoChat(token, config) {
    stopAutoChat(token);
    const { textChannelId, chatMessage, chatDelay, enableChat } = config;

    if (!enableChat || !textChannelId || !chatMessage) return;

    const delayMs = Math.max((parseInt(chatDelay) || 30), 5) * 1000; // Tối thiểu 5 giây/tin

    const timer = setInterval(async () => {
        const clientData = activeClients.get(token);
        if (!clientData || !clientData.client || !clientData.client.isReady()) return;

        try {
            const channel = await clientData.client.channels.fetch(textChannelId);
            if (channel && channel.isText()) {
                await channel.send(chatMessage);
                addLog(token, `[Auto Chat] Đã gửi tin nhắn đến kênh [${channel.name}]`);
            }
        } catch (err) {
            addLog(token, `[Lỗi Auto Chat] ${err.message}`);
        }
    }, delayMs);

    if (activeClients.has(token)) {
        activeClients.get(token).chatTimer = timer;
    }
}

async function connectVoice(config) {
    const { token, channelId, selfMute, selfDeaf, textChannelId, chatMessage, chatDelay, enableChat } = config;

    if (activeClients.has(token)) {
        try { 
            stopAutoChat(token);
            const oldData = activeClients.get(token);
            oldData.client.removeAllListeners();
            oldData.client.destroy(); 
        } catch (e) {}
        activeClients.delete(token);
    }

    const client = new Client({
        checkUpdate: false,
        sweepers: { messages: { interval: 120, lifetime: 60 } }
    });

    client.on('ready', async () => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isVoice()) {
                addLog(token, 'Lỗi: ID kênh thoại không hợp lệ!');
                client.destroy();
                return;
            }

            if (client.ws.shards && client.ws.shards.first()) {
                client.ws.shards.first().send({
                    op: 4,
                    d: {
                        guild_id: channel.guild.id,
                        channel_id: channel.id,
                        self_mute: Boolean(selfMute),
                        self_deaf: Boolean(selfDeaf)
                    }
                });
            }

            joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfMute: Boolean(selfMute),
                selfDeaf: Boolean(selfDeaf),
            });

            activeClients.set(token, {
                client: client,
                connectedAt: Date.now(),
                chatTimer: null
            });

            let db = loadDB();
            const index = db.findIndex(item => item.token === token);
            const accountData = {
                token,
                channelId,
                selfMute: Boolean(selfMute),
                selfDeaf: Boolean(selfDeaf),
                textChannelId: textChannelId || '',
                chatMessage: chatMessage || '',
                chatDelay: chatDelay || 30,
                enableChat: Boolean(enableChat),
                userId: client.user.id,
                username: client.user.tag,
                connectedAt: Date.now(),
                logs: index !== -1 && db[index].logs ? db[index].logs : []
            };

            if (index !== -1) db[index] = accountData;
            else db.push(accountData);
            saveDB(db);

            addLog(token, `Thành công: Đã kết nối vào Voice [${channel.name}]`);

            // Kích hoạt Auto Chat nếu bật
            startAutoChat(token, accountData);

        } catch (err) {
            addLog(token, `Lỗi kết nối: ${err.message}`);
        }
    });

    try {
        await client.login(token);
    } catch (err) {
        addLog(token, `Lỗi đăng nhập: Token hỏng hoặc đổi pass (${err.message})`);
    }
}

function restoreAllSessions() {
    const db = loadDB();
    db.forEach(config => connectVoice(config));
}

// Routes Giao Diện
app.get('/check', (req, res) => res.sendFile(path.join(__dirname, 'public', 'check.html')));
app.get('/taikhoan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'taikhoan.html')));
app.get('/setting', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setting.html')));

// API Kết nối
app.post('/api/connect', async (req, res) => {
    const { token, channelId, selfMute, selfDeaf } = req.body;
    if (!token || !channelId) return res.status(400).json({ success: false, message: 'Thiếu Token hoặc ID Kênh!' });

    connectVoice({ token, channelId, selfMute, selfDeaf });
    return res.json({ success: true, message: 'Đã kết nối', settingUrl: `/setting?token=${encodeURIComponent(token)}` });
});

// API Người Dùng (Cài Đặt / Setting)
app.post('/api/user/get-settings', (req, res) => {
    const { token } = req.body;
    const db = loadDB();
    const account = db.find(item => item.token === token);
    if (!account) return res.status(404).json({ success: false, message: 'Tài khoản chưa kết nối!' });

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
            chatMessage: account.chatMessage || '',
            chatDelay: account.chatDelay || 30,
            enableChat: account.enableChat || false,
            isOnline: !!active,
            logs: account.logs || []
        }
    });
});

app.post('/api/user/update-settings', (req, res) => {
    const { token, channelId, selfMute, selfDeaf, textChannelId, chatMessage, chatDelay, enableChat } = req.body;
    
    let db = loadDB();
    const index = db.findIndex(item => item.token === token);
    if (index === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });

    const updatedConfig = {
        ...db[index],
        channelId,
        selfMute: Boolean(selfMute),
        selfDeaf: Boolean(selfDeaf),
        textChannelId: textChannelId || '',
        chatMessage: chatMessage || '',
        chatDelay: parseInt(chatDelay) || 30,
        enableChat: Boolean(enableChat)
    };

    db[index] = updatedConfig;
    saveDB(db);

    // Reconnect để áp dụng cài đặt Voice & Chat mới
    connectVoice(updatedConfig);

    res.json({ success: true, message: 'Đã lưu cấu hình và áp dụng lại!' });
});

app.post('/api/disconnect', (req, res) => {
    const { token } = req.body;
    if (activeClients.has(token)) {
        try { 
            stopAutoChat(token);
            const data = activeClients.get(token);
            data.client.removeAllListeners();
            data.client.destroy(); 
        } catch (e) {}
        activeClients.delete(token);

        let db = loadDB().filter(item => item.token !== token);
        saveDB(db);

        return res.json({ success: true, message: 'Đã ngắt kết nối' });
    }
    return res.status(400).json({ success: false, message: 'Tài khoản chưa kết nối!' });
});

// API Admin
app.post('/api/accounts-management', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Sai mật khẩu Admin!' });

    const db = loadDB();
    const list = db.map(item => {
        const active = activeClients.get(item.token);
        return {
            userId: item.userId || 'Chưa xác định',
            username: item.username || 'Chưa xác định',
            token: item.token,
            isOnline: !!active,
            connectedAt: active ? active.connectedAt : null,
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
