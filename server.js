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

// 管理员配置（可修改）
const ADMIN_PASSWORD = 'admin123';  // 管理员密码

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

let messages = loadMessages();

// 存储被禁言的用户（socket.id 集合）
const mutedUsers = new Set();

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 发送历史消息
  socket.emit('allMessages', messages);

  // 用户设置昵称
  socket.on('set nickname', (nickname) => {
    socket.nickname = nickname || '匿名用户';
    socket.isAdmin = false;  // 默认不是管理员
    console.log('用户昵称:', socket.nickname);
  });

  // 管理员登录验证
  socket.on('admin login', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      socket.emit('admin login success');
      io.emit('system message', `🔑 ${socket.nickname} 已成为管理员`);
      console.log('管理员登录:', socket.nickname);
    } else {
      socket.emit('admin login fail', '密码错误');
    }
  });

  // 禁言用户（只有管理员可以调用）
  socket.on('mute user', (targetSocketId, duration) => {
    if (!socket.isAdmin) {
      socket.emit('system message', '❌ 只有管理员才能禁言用户');
      return;
    }
    mutedUsers.add(targetSocketId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('system message', `🔇 你已被管理员禁言 ${duration} 秒`);
      io.emit('system message', `🔇 ${targetSocket.nickname} 已被禁言 ${duration} 秒`);
      // 定时解除禁言
      setTimeout(() => {
        mutedUsers.delete(targetSocketId);
        if (targetSocket) {
          targetSocket.emit('system message', '🔊 你的禁言已解除');
        }
      }, duration * 1000);
    }
  });

  // 永久禁言（只有管理员可以调用）
  socket.on('mute user permanent', (targetSocketId) => {
    if (!socket.isAdmin) {
      socket.emit('system message', '❌ 只有管理员才能禁言用户');
      return;
    }
    mutedUsers.add(targetSocketId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('system message', '🔇 你已被永久禁言');
      io.emit('system message', `🔇 ${targetSocket.nickname} 已被永久禁言`);
    }
  });

  // 解除禁言（只有管理员可以调用）
  socket.on('unmute user', (targetSocketId) => {
    if (!socket.isAdmin) {
      socket.emit('system message', '❌ 只有管理员才能解除禁言');
      return;
    }
    mutedUsers.delete(targetSocketId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('system message', '🔊 你已被解除禁言');
    }
  });

  // 接收新消息
  socket.on('chat message', (msg) => {
    // 检查是否被禁言
    if (mutedUsers.has(socket.id)) {
      socket.emit('system message', '🔇 你已被禁言，无法发送消息');
      return;
    }

    const messageData = {
      avatar: '😊',
      nickname: socket.nickname || '匿名用户',
      text: msg,
      time: new Date().toLocaleTimeString(),
      isAdmin: socket.isAdmin || false  // 标记是否为管理员消息
    };

    const historyEntry = `${messageData.avatar} ${messageData.nickname}: ${messageData.text}`;
    messages.push(historyEntry);
    saveMessages(messages);

    io.emit('chat message', messageData);
  });

  // 获取在线用户列表（用于管理员选择禁言对象）
  socket.on('get users', () => {
    const users = [];
    for (const [id, s] of io.sockets.sockets) {
      users.push({
        id: id,
        nickname: s.nickname || '匿名用户',
        isAdmin: s.isAdmin || false
      });
    }
    socket.emit('users list', users);
  });

  // 用户断开连接
  socket.on('disconnect', () => {
    mutedUsers.delete(socket.id);
    console.log('用户断开:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`聊天室运行在 http://localhost:${PORT}`);
});
