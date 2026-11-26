const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

// 提供静态文件服务
app.use(express.static('public'));

// 健康检查端点
app.get('/health', (req, res) => {
  res.send('OK');
});

// 存储在线用户
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('客户端已连接:', socket.id);

  // 用户加入聊天室
  socket.on('join', (userData) => {
    onlineUsers.set(socket.id, userData);
    socket.broadcast.emit('userJoined', {
      username: userData.username,
      onlineCount: onlineUsers.size
    });
    io.emit('onlineCount', onlineUsers.size);
  });

  // 发送文本消息
  socket.on('chat message', (msg) => {
    const user = onlineUsers.get(socket.id) || { username: '匿名用户' };
    io.emit('chat message', {
      username: user.username,
      message: msg,
      time: new Date().toLocaleTimeString()
    });
  });

  // 发送图片消息（Base64）
  socket.on('sendChatImage', (msgData) => {
    const user = onlineUsers.get(socket.id) || { username: '匿名用户' };
    io.emit('receiveChatImage', {
      username: user.username,
      imageContent: msgData.imageContent,
      time: new Date().toLocaleTimeString()
    });
  });

  // 用户断开连接
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      onlineUsers.delete(socket.id);
      socket.broadcast.emit('userLeft', {
        username: user.username,
        onlineCount: onlineUsers.size
      });
      io.emit('onlineCount', onlineUsers.size);
    }
    console.log('客户端已断开:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
