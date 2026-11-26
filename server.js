const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// 读取历史消息
function loadMessages() {
  try {
    const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

// 保存消息到文件
function saveMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

// 根路由：发送 index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 加载历史消息
let messages = loadMessages();

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 新用户连接时，发送全部历史消息
  socket.emit('allMessages', messages);

  // 接收用户设置的昵称
  socket.on('set nickname', (nickname) => {
    socket.nickname = nickname || '匿名用户';
    console.log('用户昵称:', socket.nickname);
  });

  // 接收新消息
  socket.on('chat message', (msg) => {
    const messageData = {
      avatar: '😊',  // 统一笑脸头像
      nickname: socket.nickname || '匿名用户',
      text: msg,
      time: new Date().toLocaleTimeString()
    };

    // 保存到历史记录（格式化为字符串）
    const historyEntry = `${messageData.avatar} ${messageData.nickname}: ${messageData.text}`;
    messages.push(historyEntry);
    saveMessages(messages);

    // 广播给所有客户端（包括发送者）
    io.emit('chat message', messageData);
  });

  // 用户断开连接
  socket.on('disconnect', () => {
    console.log('用户断开:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`聊天室运行在 http://localhost:${PORT}`);
});
