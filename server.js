const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 静态文件服务：托管项目目录下的所有文件（包括 index.html）
app.use(express.static(__dirname));

// 健康检查端点（Render 平台需要）
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// 在线用户集合：socket.id -> 昵称
const onlineUsers = new Map();

io.on('connection', (socket) => {
    console.log('新用户连接:', socket.id);

    // 用户设置昵称后加入在线列表
    socket.on('setNickname', (nickname) => {
        const name = nickname || '匿名用户';
        onlineUsers.set(socket.id, name);
        console.log('用户上线:', name);

        // 广播更新后的在线用户列表给所有客户端
        io.emit('onlineUsers', Array.from(onlineUsers.values()));
    });

    // 接收文本消息并广播
    socket.on('chatMessage', (data) => {
        io.emit('chatMessage', data);
    });

    // 用户断开连接时移除
    socket.on('disconnect', () => {
        const name = onlineUsers.get(socket.id);
        if (name) {
            console.log('用户下线:', name);
            onlineUsers.delete(socket.id);
            // 广播更新后的在线用户列表
            io.emit('onlineUsers', Array.from(onlineUsers.values()));
        }
        console.log('用户断开:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
