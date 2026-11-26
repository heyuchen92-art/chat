const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// 管理员密码（生产环境建议改为环境变量）
const ADMIN_PASSWORD = 'admin123';

// 存储在线用户
const onlineUsers = new Map(); // socket.id -> { nickname, isAdmin }
// 存储被禁言用户
const mutedUsers = new Map(); // socket.id -> { until, permanent }

// 读取历史消息
function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('读取消息文件失败:', err);
  }
  return [];
}

// 保存消息
function saveMessages(messages) {
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch (err) {
    console.error('保存消息失败:', err);
  }
}

// 根路径路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 静态资源
app.use(express.static(__dirname));

// 初始化消息存储
let messages = loadMessages();

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 发送历史消息
  socket.emit('allMessages', messages);

  // 设置昵称
  socket.on('set nickname', (nickname) => {
    socket.nickname = nickname;
    socket.isAdmin = false;
    onlineUsers.set(socket.id, { nickname, isAdmin: false });
    io.emit('online users', Array.from(onlineUsers.values()));
    io.emit('system notification', {
      text: `${nickname} 加入了聊天室`,
      type: 'join'
    });
  });

  // 管理员登录
  socket.on('admin login', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      onlineUsers.set(socket.id, { nickname: socket.nickname, isAdmin: true });
      io.emit('online users', Array.from(onlineUsers.values()));
      socket.emit('admin login success');
      io.emit('system notification', {
        text: `${socket.nickname} 已成为管理员`,
        type: 'admin'
      });
    } else {
      socket.emit('admin login fail', '密码错误');
    }
  });

  // 处理聊天消息
  socket.on('chat message', (msg) => {
    // 检查是否被禁言
    const muteInfo = mutedUsers.get(socket.id);
    if (muteInfo) {
      if (muteInfo.permanent) {
        socket.emit('system notification', {
          text: '你已被永久禁言，无法发送消息',
          type: 'mute'
        });
        return;
      }
      if (muteInfo.until > Date.now()) {
        const remaining = Math.ceil((muteInfo.until - Date.now()) / 1000);
        socket.emit('system notification', {
          text: `你已被禁言，剩余 ${remaining} 秒`,
          type: 'mute'
        });
        return;
      }
      // 禁言已过期，解除
      mutedUsers.delete(socket.id);
    }

    const message = {
      avatar: '😊',
      nickname: socket.nickname || '匿名用户',
      text: msg.text,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      isAdmin: socket.isAdmin || false
    };

    // 保存到历史消息
    messages.push(message);
    saveMessages(messages);

    // 广播消息
    io.emit('chat message', message);
  });

  // 禁言用户（仅管理员）
  socket.on('mute user', (data) => {
    if (!socket.isAdmin) {
      socket.emit('system notification', {
        text: '只有管理员才能禁言用户',
        type: 'error'
      });
      return;
    }

    const targetSocket = io.sockets.sockets.get(data.targetId);
    if (!targetSocket) {
      socket.emit('system notification', {
        text: '目标用户不在线',
        type: 'error'
      });
      return;
    }

    if (data.duration === 'permanent') {
      mutedUsers.set(data.targetId, { permanent: true });
      io.emit('system notification', {
        text: `${targetSocket.nickname} 已被永久禁言`,
        type: 'mute'
      });
    } else {
      const durationMs = data.duration * 1000;
      mutedUsers.set(data.targetId, { until: Date.now() + durationMs });
      io.emit('system notification', {
        text: `${targetSocket.nickname} 已被禁言 ${data.duration} 秒`,
        type: 'mute'
      });
      
      // 定时解除禁言
      setTimeout(() => {
        if (mutedUsers.has(data.targetId) && !mutedUsers.get(data.targetId).permanent) {
          mutedUsers.delete(data.targetId);
          io.emit('system notification', {
            text: `${targetSocket.nickname} 禁言已解除`,
            type: 'unmute'
          });
        }
      }, durationMs);
    }
  });

  // 解除禁言（仅管理员）
  socket.on('unmute user', (data) => {
    if (!socket.isAdmin) {
      socket.emit('system notification', {
        text: '只有管理员才能解除禁言',
        type: 'error'
      });
      return;
    }

    if (mutedUsers.has(data.targetId)) {
      mutedUsers.delete(data.targetId);
      const targetSocket = io.sockets.sockets.get(data.targetId);
      io.emit('system notification', {
        text: `${targetSocket ? targetSocket.nickname : '用户'} 已被解除禁言`,
        type: 'unmute'
      });
    }
  });

  // 断开连接
  socket.on('disconnect', () => {
    if (socket.nickname) {
      onlineUsers.delete(socket.id);
      mutedUsers.delete(socket.id);
      io.emit('online users', Array.from(onlineUsers.values()));
      io.emit('system notification', {
        text: `${socket.nickname} 离开了聊天室`,
        type: 'leave'
      });
    }
    console.log('用户断开:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`聊天室服务器已启动: http://localhost:${PORT}`);
});
