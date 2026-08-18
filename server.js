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
const activeClients = new Map();

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
    const timestamp = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const logEntry = `[${timestamp}] ${message}`;

    if (index !== -1) {
        if (!db[index].logs) db[index].logs = [];
        db[index].logs.unshift(logEntry);
        if (db[index].logs.length > 10) db[index].logs.pop();
        saveDB(db);
    }
}

function addChatLog(token, chatMsg) {
    let db = loadDB();
    const index = db.findIndex(item => item.token === token);
    const timestamp = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const entry = `[${timestamp}] ${chatMsg}`;

    if (index !== -1) {
        if (!db[index].chatLogs) db[index].chatLogs = [];
        db[index].chatLogs.unshift(entry);
        if (db[index].chatLogs.length > 25) db[index].chatLogs.pop(); // Lưu 25 tin nhắn gần nhất
        saveDB(db);
    }
}

async function connectVoice(config) {
    const { token, channelId, selfMute, selfDeaf, textChannelId } = config;

    if (activeClients.has(token)) {
        try { 
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
                        selfDeaf: Boolean(selfDeaf)
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
                connectedAt: Date.now()
            });

            let db = loadDB();
            const index = db.findIndex(item => item.token === token);
            const accountData = {
                token,
                channelId,
                selfMute: Boolean(selfMute),
                selfDeaf: Boolean(selfDeaf),
                textChannelId: textChannelId || '',
                userId: client.user.id,
                username: client.user.tag,
                connectedAt: Date.now(),
                logs: index !== -1 && db[index].logs ? db[index].logs : [],
                chatLogs: index !== -1 && db[index].chatLogs ? db[index].chatLogs : []
            };

            if (index !== -1) db[index] = accountData;
            else db.push(accountData);
            saveDB(db);

            addLog(token, `Thành công: Đã kết nối vào Voice [${channel.name}]`);

        } catch (err) {
            addLog(token, `Lỗi kết nối: ${err.message}`);
        }
    });

    // Bắt tin nhắn realtime từ kênh chat được cài đặt
    client.on('messageCreate', (message) => {
        let db = loadDB();
        const account = db.find(item => item.token === token);
        if (account && account.textChannelId && message.channel.id === account.textChannelId) {
            const sender = message.author.tag;
            const content = message.content || '[Tệp/Sticker/Hình ảnh]';
            addChatLog(token, `${sender}: ${content}`);
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

app.post('/api/connect', async (req, res) => {
    const { token, channelId, selfMute, selfDeaf } = req.body;
    if (!token || !channelId) return res.status(400).json({ success: false, message: 'Thiếu Token hoặc ID Kênh!' });

    connectVoice({ token, channelId, selfMute, selfDeaf });
    return res.json({ success: true, message: 'Đã kết nối', settingUrl: `/setting?token=${encodeURIComponent(token)}` });
});

// Lấy thông tin cài đặt & Chat Logs
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
            isOnline: !!active,
            logs: account.logs || [],
            chatLogs: account.chatLogs || []
        }
    });
});

// Cập nhật cấu hình
app.post('/api/user/update-settings', (req, res) => {
    const { token, channelId, selfMute, selfDeaf, textChannelId } = req.body;
    
    let db = loadDB();
    const index = db.findIndex(item => item.token === token);
    if (index === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });

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

// Gửi 1 tin nhắn trực tiếp từ Web sang Discord
app.post('/api/user/send-message', async (req, res) => {
    const { token, message } = req.body;
    const db = loadDB();
    const account = db.find(item => item.token === token);

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
        } else {
            addChatLog(token, `[Lỗi Gửi]: ID Kênh không phải kênh chat văn bản!`);
            return res.status(400).json({ success: false, message: 'Kênh không hợp lệ!' });
        }
    } catch (err) {
        addChatLog(token, `[Lỗi Gửi]: ${err.message}`);
        return res.status(500).json({ success: false, message: `Lỗi: ${err.message}` });
    }
});

app.post('/api/disconnect', (req, res) => {
    const { token } = req.body;
    if (activeClients.has(token)) {
        try { 
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
