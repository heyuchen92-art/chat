const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 消息文件路径
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// 读取历史消息（文件不存在时返回空数组）
function loadMessages() {
  try {
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch (err) {
    return [];
  }
}

// 保存消息到文件
function saveMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

// 托管 index.html
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// 初始化消息列表
let messages = loadMessages();

io.on('connection', (socket) => {
  // 新用户连接时，发送历史消息
  socket.emit('allMessages', messages);

  // 收到新消息时，保存并广播
  socket.on('chat message', (msg) => {
    messages.push(msg);
    saveMessages(messages);  // 写入 messages.json
    io.emit('chat message', msg);
  });
});

server.listen(3000, () => {
  console.log('服务器运行在 http://localhost:3000');
});
