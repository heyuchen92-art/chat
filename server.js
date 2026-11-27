const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// 调高传输上限至 5MB，防止 2MB 图片转 Base64 后超出默认限制
const io = new Server(server, {
  maxHttpBufferSize: 5e6
});

// ========== 配置 ==========
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const MAX_HISTORY = 100;

// ========== 静态资源（拦截同目录下的敏感文件） ==========
app.use((req, res, next) => {
  const blockedFiles = ['/messages.json', '/server.js', '/package.json', '/package-lock.json'];
  if (blockedFiles.includes(req.path.toLowerCase())) {
    return res.status(403).send('禁止访问');
  }
  next();
});

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

let isSaving = false;
let pendingSave = false;

async function saveMessages() {
  if (isSaving) {
    pendingSave = true;
    return;
  }
  isSaving = true;
  try {
    await fs.promises.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch (err) {
    console.error('保存历史消息失败:', err);
  } finally {
    isSaving = false;
    if (pendingSave) {
      pendingSave = false;
      saveMessages();
    }
  }
}

// ========== 状态管理 ==========
const mutedUsers = new Map();
const pokeCooldown = new Map();

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 用户加入
  socket.on('join', (rawNickname) => {
    let nickname = String(rawNickname || '').trim().slice(0, 20);
    if (!nickname) return;

    // 防止重名冲突
    const onlineUsers = getOnlineUsers();
    if (onlineUsers.some(u => u.nickname === nickname)) {
      nickname = `${nickname}_${Math.floor(10 + Math.random() * 90)}`;
    }

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
      io.emit('system message', { text: `管理员 (${socket.nickname}) 已上线` });
      io.emit('online users', getOnlineUsers());
    } else {
      socket.emit('admin login fail');
    }
  });

  // 发送消息
  socket.on('chat message', (msg) => {
    const nickname = socket.nickname;
    if (!nickname || !msg) return;

    // 禁言检查
    const muteUntil = mutedUsers.get(nickname);
    if (muteUntil !== undefined) {
      if (muteUntil === 0 || Date.now() < muteUntil) {
        const timeStr = muteUntil === 0
          ? '永久'
          : `至 ${new Date(muteUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        socket.emit('muted notice', { message: `您已被禁言${timeStr}` });
        return;
      } else {
        mutedUsers.delete(nickname);
      }
    }

    const text = String(msg.text || '').trim().slice(0, 1000);
    const image = (typeof msg.image === 'string' && msg.image.startsWith('data:image/'))
      ? msg.image
      : null;

    if (!text && !image) return;

    const message = {
      nickname,
      text,
      image,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      isAdmin: socket.isAdmin || false
    };

    messages.push(message);
    if (messages.length > MAX_HISTORY) {
      messages = messages.slice(-MAX_HISTORY);
    }

    saveMessages();
    io.emit('chat message', message);
  });

  // 禁言用户（仅管理员）
  socket.on('mute user', (data) => {
    if (!socket.isAdmin || !data) return;
    const { nickname, duration } = data;
    const mins = Math.max(0, parseInt(duration, 10) || 0);
    const muteUntil = mins === 0 ? 0 : Date.now() + mins * 60 * 1000;

    mutedUsers.set(nickname, muteUntil);
    io.emit('system message', {
      text: `管理员已将 ${nickname} 禁言${mins === 0 ? '（永久）' : ` ${mins} 分钟`}`
    });
  });

  // 解除禁言（仅管理员）
  socket.on('unmute user', (nickname) => {
    if (!socket.isAdmin || !nickname) return;
    mutedUsers.delete(nickname);
    io.emit('system message', { text: `管理员已解除 ${nickname} 的禁言` });
  });

  // 戳一戳功能（仅管理员，Beta）
  socket.on('poke user', (targetNickname) => {
    if (!socket.isAdmin || !targetNickname) return;

    // 3秒防刷冷却
    const now = Date.now();
    const lastPoke = pokeCooldown.get(socket.id) || 0;
    if (now - lastPoke < 3000) return;
    pokeCooldown.set(socket.id, now);

    let targetSocket = null;
    for (const [, s] of io.of('/').sockets) {
      if (s.nickname === targetNickname) {
        targetSocket = s;
        break;
      }
    }

    if (targetSocket) {
      targetSocket.emit('poked', { from: socket.nickname });
      io.emit('system message', {
        text: `👉 管理员 ${socket.nickname} 戳了戳 ${targetNickname}`
      });
    }
  });

  // 获取历史消息
  socket.on('get history', () => {
    socket.emit('history', messages);
  });

  // 断开连接
  socket.on('disconnect', () => {
    pokeCooldown.delete(socket.id);
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
