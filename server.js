const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 静态文件服务
app.use(express.static(__dirname));

// 健康检查
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('新用户连接:', socket.id);

    // 接收消息并广播（不再需要服务端存储历史，由前端 localStorage 负责）
    socket.on('chatMessage', (data) => {
        io.emit('chatMessage', data);
    });

    socket.on('disconnect', () => {
        console.log('用户断开:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
