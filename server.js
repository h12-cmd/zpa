const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel } = require('@discordjs/voice');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentClient = null;

app.post('/api/connect', async (req, res) => {
    const { token, channelId, selfMute, selfDeaf } = req.body;

    if (!token || !channelId) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ Token và ID Kênh!' });
    }

    if (currentClient) {
        try { currentClient.destroy(); } catch (e) {}
        currentClient = null;
    }

    const client = new Client();

    client.on('ready', async () => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isVoice()) {
                return res.status(400).json({ success: false, message: 'ID kênh thoại không đúng!' });
            }

            joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfMute: Boolean(selfMute),
                selfDeaf: Boolean(selfDeaf),
            });

            return res.json({ success: true, message: `Đã treo voice thành công trong kênh: ${channel.name}` });
        } catch (err) {
            return res.status(500).json({ success: false, message: `Lỗi: ${err.message}` });
        }
    });

    try {
        await client.login(token);
        currentClient = client;
    } catch (err) {
        return res.status(400).json({ success: false, message: 'Token không hợp lệ hoặc sai định dạng!' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy tại port ${PORT}`));