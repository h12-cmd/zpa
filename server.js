const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel } = require('@discordjs/voice');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lưu trữ danh sách nhiều tài khoản đang kết nối
const activeClients = new Map();

app.post('/api/connect', async (req, res) => {
    const { token, channelId, selfMute, selfDeaf } = req.body;

    if (!token || !channelId) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ Token và ID Kênh!' });
    }

    // Nếu Token này đã kết nối từ trước, ngắt kết nối cũ để tạo kết nối mới
    if (activeClients.has(token)) {
        try { activeClients.get(token).destroy(); } catch (e) {}
        activeClients.delete(token);
    }

    const client = new Client();

    client.on('ready', async () => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isVoice()) {
                client.destroy();
                return res.status(400).json({ success: false, message: 'ID kênh thoại không đúng hoặc không phải kênh Voice!' });
            }

            joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfMute: Boolean(selfMute),
                selfDeaf: Boolean(selfDeaf),
            });

            activeClients.set(token, client);

            return res.json({ 
                success: true, 
                message: `[${client.user.tag}] Đã treo voice thành công vào kênh: ${channel.name}` 
            });
        } catch (err) {
            client.destroy();
            return res.status(500).json({ success: false, message: `Lỗi kết nối: ${err.message}` });
        }
    });

    try {
        await client.login(token);
    } catch (err) {
        return res.status(400).json({ success: false, message: 'Token không hợp lệ hoặc đã bị đổi mật khẩu!' });
    }
});

// API hỗ trợ ngắt kết nối từng tài khoản
app.post('/api/disconnect', (req, res) => {
    const { token } = req.body;
    if (activeClients.has(token)) {
        try { activeClients.get(token).destroy(); } catch (e) {}
        activeClients.delete(token);
        return res.json({ success: true, message: 'Đã ngắt kết nối voice thành công!' });
    }
    return res.status(400).json({ success: false, message: 'Tài khoản này chưa treo voice trên hệ thống!' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server đang chạy tại port ${PORT}`));
