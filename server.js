const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const port = process.env.PORT || 3000;

// 静态文件服务 - 直接使用当前文件夹
app.use(express.static(__dirname));

// 健康检查端点（Render 需要）
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 在线用户管理
let onlineUsers = 0;

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('userCount', onlineUsers);

  // 用户加入通知
  socket.on('userJoined', (username) => {
    socket.broadcast.emit('systemMessage', `${username} 加入了聊天室`);
  });

  // 接收并广播文本消息
  socket.on('chatMessage', (data) => {
    io.emit('chatMessage', data);
  });

  // 接收并广播图片消息（Base64）
  socket.on('imageMessage', (data) => {
    io.emit('imageMessage', data);
  });

  // 用户断开连接
  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('userCount', onlineUsers);
  });
});

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
