const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 静态文件服务：托管 index.html、style.css 等文件
app.use(express.static(__dirname));

// 健康检查端点（Render 平台需要）
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// 内存存储聊天记录（最多 200 条）
const messageHistory = [];

io.on('connection', (socket) => {
    console.log('新用户连接:', socket.id);

    // 发送历史记录给新连接的用户
    socket.emit('history', messageHistory);

    // 接收聊天消息并广播
    socket.on('chatMessage', (data) => {
        const message = {
            text: data.text,
            nickname: data.nickname || '匿名用户',
            avatar: data.avatar || '😀',
            timestamp: new Date().toISOString()
        };

        // 保存到历史记录（最多 200 条）
        messageHistory.push(message);
        if (messageHistory.length > 200) {
            messageHistory.shift();
        }

        // 广播给所有客户端
        io.emit('chatMessage', message);
    });

    // 用户断开连接
    socket.on('disconnect', () => {
        console.log('用户断开:', socket.id);
    });
});

// 端口配置（Render 平台使用环境变量 PORT）
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
