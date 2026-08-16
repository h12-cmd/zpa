const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel } = require('@discordjs/voice');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeClients = new Map();

app.get('/check', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'check.html'));
});

app.get('/api/status', (req, res) => {
    const activeList = [];

    activeClients.forEach((data) => {
        const username = data.client.user ? data.client.user.username : 'Unknown';
        
        let maskedName = '***';
        if (username.length <= 2) {
            maskedName = username[0] + '*';
        } else {
            maskedName = username[0] + '***' + username[username.length - 1];
        }

        activeList.push({
            name: maskedName,
            connectedAt: data.connectedAt
        });
    });

    res.json({
        total: activeList.length,
        accounts: activeList
    });
});

app.post('/api/connect', async (req, res) => {
    const { token, channelId, selfMute, selfDeaf } = req.body;

    if (!token || !channelId) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ Token và ID Kênh!' });
    }

    if (activeClients.has(token)) {
        try { activeClients.get(token).client.destroy(); } catch (e) {}
        activeClients.delete(token);
    }

    const client = new Client();

    client.on('ready', async () => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isVoice()) {
                client.destroy();
                return res.status(400).json({ success: false, message: 'ID kênh thoại không hợp lệ!' });
            }

            // Gửi Opcode 4 chuẩn qua Shard
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
                connectedAt: Date.now()
            });

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
        return res.status(400).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn!' });
    }
});

app.post('/api/disconnect', (req, res) => {
    const { token } = req.body;
    if (activeClients.has(token)) {
        try { activeClients.get(token).client.destroy(); } catch (e) {}
        activeClients.delete(token);
        return res.json({ success: true, message: 'Đã ngắt kết nối voice thành công!' });
    }
    return res.status(400).json({ success: false, message: 'Tài khoản này chưa kết nối!' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server đang chạy tại port ${PORT}`));
