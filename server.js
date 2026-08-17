const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'database.json');
const activeClients = new Map();

// Hàm đọc Database
function loadDB() {
    if (!fs.existsSync(DB_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

// Hàm lưu Database
function saveDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {}
}

// Hàm ghi log lỗi/trạng thái cho từng tài khoản
function addLog(token, message) {
    let db = loadDB();
    const index = db.findIndex(item => item.token === token);
    const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const logEntry = `[${timestamp}] ${message}`;

    if (index !== -1) {
        if (!db[index].logs) db[index].logs = [];
        db[index].logs.unshift(logEntry); // Đưa log mới nhất lên đầu
        if (db[index].logs.length > 20) db[index].logs.pop(); // Giới hạn 20 log
        saveDB(db);
    }
}

// Hàm kết nối Voice
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
                addLog(token, 'Lỗi: ID kênh thoại không hợp lệ hoặc không phải kênh Voice!');
                client.destroy();
                return;
            }

            // Gửi Opcode 4
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

            // Tự động kết nối lại khi mất mạng
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                addLog(token, 'Cảnh báo: Mất kết nối Voice tạm thời, đang thử kết nối lại...');
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                    ]);
                } catch (e) {
                    try { connection.destroy(); } catch (err) {}
                    addLog(token, 'Lỗi: Thử kết nối lại thất bại. Tiến hành tạo lại phiên làm việc sau 5s...');
                    setTimeout(() => connectVoice(config), 5000);
                }
            });

            activeClients.set(token, {
                client: client,
                connectedAt: Date.now()
            });

            // Cập nhật thông tin vào Database
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

            if (index !== -1) {
                db[index] = accountData;
            } else {
                db.push(accountData);
            }
            saveDB(db);

            addLog(token, `Thành công: Đã kết nối vào phòng thoại [${channel.name}]`);

        } catch (err) {
            addLog(token, `Lỗi kết nối: ${err.message}`);
        }
    });

    try {
        await client.login(token);
    } catch (err) {
        addLog(token, `Lỗi đăng nhập: Token không hợp lệ hoặc đã hết hạn (${err.message})`);
    }
}

function restoreAllSessions() {
    const db = loadDB();
    db.forEach(config => connectVoice(config));
}

// Router chuyển hướng
app.get('/check', (req, res) => res.sendFile(path.join(__dirname, 'public', 'check.html')));
app.get('/taikhoan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'taikhoan.html')));

// API công khai công khai (/check)
app.get('/api/status', (req, res) => {
    const activeList = [];
    activeClients.forEach((data) => {
        const username = data.client.user ? data.client.user.username : 'Unknown';
        let maskedName = username.length <= 2 ? username[0] + '*' : username[0] + '***' + username[username.length - 1];
        activeList.push({ name: maskedName, connectedAt: data.connectedAt });
    });
    res.json({ total: activeList.length, accounts: activeList });
});

// API Quản lý tài khoản (/taikhoan)
app.get('/api/accounts-management', (req, res) => {
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
    res.json({ total: list.length, accounts: list });
});

// API Xác minh ID người dùng để lấy Token
app.post('/api/reveal-token', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Vui lòng nhập ID người dùng!' });

    const db = loadDB();
    const account = db.find(item => item.userId === userId.trim());

    if (account) {
        return res.json({ success: true, token: account.token });
    } else {
        return res.status(404).json({ success: false, message: 'ID người dùng không khớp với bất kỳ tài khoản nào trên hệ thống!' });
    }
});

app.post('/api/connect', async (req, res) => {
    const { token, channelId, selfMute, selfDeaf } = req.body;
    if (!token || !channelId) return res.status(400).json({ success: false, message: 'Thiếu Token hoặc ID Kênh!' });

    connectVoice({ token, channelId, selfMute, selfDeaf });
    return res.json({ success: true, message: 'Đã gửi yêu cầu kết nối! Kiểm tra trạng thái tại /taikhoan' });
});

app.post('/api/disconnect', (req, res) => {
    const { token } = req.body;
    if (activeClients.has(token)) {
        try { activeClients.get(token).client.destroy(); } catch (e) {}
        activeClients.delete(token);

        let db = loadDB().filter(item => item.token !== token);
        saveDB(db);

        return res.json({ success: true, message: 'Đã ngắt kết nối và xóa dữ liệu!' });
    }
    return res.status(400).json({ success: false, message: 'Tài khoản này chưa kết nối!' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
    restoreAllSessions();
});
