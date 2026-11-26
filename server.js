const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const port = process.env.PORT || 3000;

// 静态文件服务
app.use(express.static(__dirname));

// 健康检查端点
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 聊天记录存储（内存中，重启后丢失）
// 如需永久保存，可改用文件或数据库
const messageHistory = [];
const MAX_HISTORY = 200; // 最多保存200条

// 在线用户管理
let onlineUsers = 0;

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('userCount', onlineUsers);

  // 新用户连接时，发送历史聊天记录
  socket.emit('history', messageHistory);

  // 用户加入通知
  socket.on('userJoined', (username) => {
    socket.broadcast.emit('systemMessage', `${username} 加入了聊天室`);
  });

  // 接收并广播文本消息
  socket.on('chatMessage', (data) => {
    // 存储到历史记录
    const msg = {
      type: 'text',
      username: data.username,
      avatar: data.avatar,
      text: data.text,
      time: Date.now()
    };
    messageHistory.push(msg);
    // 限制历史记录长度
    if (messageHistory.length > MAX_HISTORY) {
      messageHistory.shift();
    }
    // 广播给所有用户
    io.emit('chatMessage', msg);
  });

  // 接收并广播图片消息
  socket.on('imageMessage', (data) => {
    const msg = {
      type: 'image',
      username: data.username,
      avatar: data.avatar,
      image: data.image,
      time: Date.now()
    };
    messageHistory.push(msg);
    if (messageHistory.length > MAX_HISTORY) {
      messageHistory.shift();
    }
    io.emit('imageMessage', msg);
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
