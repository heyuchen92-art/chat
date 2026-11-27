const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ========== 配置 ==========
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// ========== 静态资源 ==========
app.use(express.static(path.join(__dirname)));

// ========== 消息持久化（JSON 文件） ==========
let messages = [];
if (fs.existsSync(MESSAGES_FILE)) {
  try {
    messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch (e) {
    messages = [];
  }
}

function saveMessages() {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

// ========== 禁言状态 ==========
// key: 昵称, value: 禁言截止时间戳（0 表示永久）
const mutedUsers = new Map();

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 用户加入
  socket.on('join', (nickname) => {
    socket.nickname = nickname;
    socket.isAdmin = false;
    socket.broadcast.emit('system message', { text: `${nickname} 加入了聊天室` });
    io.emit('online users', getOnlineUsers());
  });

  // 管理员登录
  socket.on('admin login', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      socket.emit('admin login success');
      io.emit('system message', { text: '管理员已上线' });
    } else {
      socket.emit('admin login fail');
    }
  });

  // 发送消息
  socket.on('chat message', (msg) => {
    const nickname = socket.nickname;
    if (!nickname) return;

    // 禁言检查
    const muteUntil = mutedUsers.get(nickname);
    if (muteUntil !== undefined) {
      if (muteUntil === 0 || Date.now() < muteUntil) {
        const timeStr = muteUntil === 0 ? '永久' : `至 ${new Date(muteUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        socket.emit('muted notice', { message: `您已被禁言${timeStr}` });
        return;
      } else {
        mutedUsers.delete(nickname);
      }
    }

    const message = {
      nickname,
      text: msg.text || '',
      image: msg.image || null,  // Base64 字符串
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      isAdmin: socket.isAdmin || false
    };

    messages.push(message);
    saveMessages();
    io.emit('chat message', message);
  });

  // 禁言用户（仅管理员）
  socket.on('mute user', (data) => {
    if (!socket.isAdmin) return;
    const { nickname, duration } = data;
    const muteUntil = duration === 0 ? 0 : Date.now() + duration * 60 * 1000;
    mutedUsers.set(nickname, muteUntil);
    io.emit('user muted', { nickname, duration });
    io.emit('system message', { text: `管理员已将 ${nickname} 禁言${duration === 0 ? '（永久）' : ` ${duration} 分钟`}` });
  });

  // 解除禁言（仅管理员）
  socket.on('unmute user', (nickname) => {
    if (!socket.isAdmin) return;
    mutedUsers.delete(nickname);
    io.emit('user unmuted', { nickname });
    io.emit('system message', { text: `管理员已解除 ${nickname} 的禁言` });
  });

  // 获取历史消息
  socket.on('get history', () => {
    socket.emit('history', messages);
  });

  // 断开连接
  socket.on('disconnect', () => {
    if (socket.nickname) {
      socket.broadcast.emit('system message', { text: `${socket.nickname} 离开了聊天室` });
      io.emit('online users', getOnlineUsers());
    }
  });
});

function getOnlineUsers() {
  const users = [];
  for (const [id, socket] of io.of('/').sockets) {
    if (socket.nickname) {
      users.push({ id, nickname: socket.nickname, isAdmin: socket.isAdmin });
    }
  }
  return users;
}

// ========== 启动 ==========
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
