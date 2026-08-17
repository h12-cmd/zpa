const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MẬT KHẨU ADMIN ĐÃ ĐỔI THÀNH "Ngg"
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
    const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const logEntry = `[${timestamp}] ${message}`;

    if (index !== -1) {
        if (!db[index].logs) db[index].logs = [];
        db[index].logs.unshift(logEntry);
        if (db[index].logs.length > 20) db[index].logs.pop();
        saveDB(db);
    }
}

async function connectVoice(config) {
    const { token, channelId, selfMute, selfDeaf } = config;

    if (activeClients.has(token)) {
        try { activeClients.get(token).client.destroy(); } catch (e) {}
        activeClients.delete(token);
    }

    const client = new Client();

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

            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfMute: Boolean(selfMute),
                selfDeaf: Boolean(selfDeaf),
            });

            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                addLog(token, 'Cảnh báo: Mất kết nối Voice, đang thử lại...');
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                    ]);
                } catch (e) {
                    try { connection.destroy(); } catch (err) {}
                    addLog(token, 'Lỗi: Thử lại thất bại. Đang tạo lại phiên sau 5s...');
                    setTimeout(() => connectVoice(config), 5000);
                }
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
                selfMute,
                selfDeaf,
                userId: client.user.id,
                username: client.user.tag,
                connectedAt: Date.now(),
                logs: index !== -1 && db[index].logs ? db[index].logs : []
            };

            if (index !== -1) db[index] = accountData;
            else db.push(accountData);
            saveDB(db);

            addLog(token, `Thành công: Đã kết nối vào phòng [${channel.name}]`);

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

app.get('/check', (req, res) => res.sendFile(path.join(__dirname, 'public', 'check.html')));
app.get('/taikhoan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'taikhoan.html')));

app.get('/api/status', (req, res) => {
    const activeList = [];
    activeClients.forEach((data) => {
        const username = data.client.user ? data.client.user.username : 'Unknown';
        let maskedName = username.length <= 2 ? username[0] + '*' : username[0] + '***' + username[username.length - 1];
        activeList.push({ name: maskedName, connectedAt: data.connectedAt });
    });
    res.json({ total: activeList.length, accounts: activeList });
});

// Đã cập nhật thông báo ngắn gọn thành "Đã kết nối"
app.post('/api/connect', async (req, res) => {
    const { token, channelId, selfMute, selfDeaf } = req.body;
    if (!token || !channelId) return res.status(400).json({ success: false, message: 'Thiếu Token hoặc ID Kênh!' });

    connectVoice({ token, channelId, selfMute, selfDeaf });
    return res.json({ success: true, message: 'Đã kết nối' });
});

app.post('/api/disconnect', (req, res) => {
    const { token } = req.body;
    if (activeClients.has(token)) {
        try { activeClients.get(token).client.destroy(); } catch (e) {}
        activeClients.delete(token);

        let db = loadDB().filter(item => item.token !== token);
        saveDB(db);

        return res.json({ success: true, message: 'Đã ngắt kết nối' });
    }
    return res.status(400).json({ success: false, message: 'Tài khoản này chưa kết nối!' });
});

app.post('/api/accounts-management', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Mật khẩu Admin không chính xác!' });
    }

    const db = loadDB();
    const list = db.map(item => {
        const active = activeClients.get(item.token);
        return {
            username: item.username || 'Chưa xác định',
            maskedToken: item.token.substring(0, 10) + '********************',
            isOnline: !!active,
            connectedAt: active ? active.connectedAt : null,
            logs: item.logs || []
        };
    });
    res.json({ success: true, total: list.length, accounts: list });
});

app.post('/api/reveal-token', (req, res) => {
    const { password, userId } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Mật khẩu Admin không chính xác!' });
    }

    const db = loadDB();
    const account = db.find(item => item.userId === userId.trim());

    if (account) {
        return res.json({ success: true, token: account.token });
    } else {
        return res.status(404).json({ success: false, message: 'ID người dùng không chính xác!' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
    restoreAllSessions();
});
