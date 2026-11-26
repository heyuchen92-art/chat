const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // 允许跨域连接
});

// 托管前端页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 健康检查接口（用于防休眠保活）
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 监听聊天连接
io.on('connection', (socket) => {
  console.log('新用户加入:', socket.id);

  // 接收客户端发来的消息，并广播给所有人
  socket.on('chat message', (msg) => {
    io.emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    console.log('用户离开:', socket.id);
  });
});

// 必须使用环境变量 PORT，否则 Render 会报错
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`聊天服务器运行在端口 ${PORT}`);
});
