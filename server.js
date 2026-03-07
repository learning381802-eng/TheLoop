const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e8
});
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// In-memory "database" (use real DB in production)
const users = new Map();
const userAccounts = new Map();
const servers = new Map();
const channels = new Map();
const messages = new Map();
const userProfiles = new Map();
const roles = new Map();
const permissions = new Map();
const invites = new Map();
const bans = new Map();
const mutes = new Map();
const pins = new Map();
let idCounters = {
  server: 0,
  channel: 0,
  message: 0,
  invite: 0,
  role: 0
};

// Authentication Routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (userAccounts.has(email)) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    if (username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: 'Username must be 2-32 characters' });
    }

    const userId = email.replace(/[^a-zA-Z0-9]/g, '_');
    const hashedPassword = await bcrypt.hash(password, 10);

    userAccounts.set(email, {
      userId,
      email,
      username,
      password: hashedPassword,
      createdAt: new Date(),
      verified: false
    });

    userProfiles.set(userId, {
      userId,
      email,
      username,
      bio: '',
      avatar: null,
      banner: null,
      status: 'online',
      badges: [],
      nitro: false,
      createdAt: new Date()
    });

    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const account = userAccounts.get(email);

    if (!account || !await bcrypt.compare(password, account.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: account.userId, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: account.userId, username: account.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify JWT
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid token' });
    req.userId = decoded.userId;
    next();
  });
}

// User API
app.get('/api/users/:userId', (req, res) => {
  const profile = userProfiles.get(req.params.userId);
  res.json(profile || {});
});

app.post('/api/users/:userId/profile', verifyToken, (req, res) => {
  const { username, bio, avatar, banner, status } = req.body;
  const profile = userProfiles.get(req.userId) || {};
  Object.assign(profile, { username, bio, avatar, banner, status });
  userProfiles.set(req.userId, profile);
  res.json(profile);
});

// Server API
app.get('/api/servers', verifyToken, (req, res) => {
  const userServers = Array.from(servers.values()).filter(s =>
    s.members.has(req.userId) || s.owner === req.userId
  );
  res.json(userServers);
});

app.post('/api/servers', verifyToken, (req, res) => {
  const { name, icon } = req.body;
  const serverId = `srv_${++idCounters.server}`;
  const defaultRoleId = `role_${++idCounters.role}`;

  const server = {
    id: serverId,
    name,
    icon: icon || '🎮',
    owner: req.userId,
    members: new Map([[req.userId, { role: 'owner', joinedAt: new Date() }]]),
    roles: new Map([[defaultRoleId, {
      id: defaultRoleId,
      name: '@everyone',
      color: '#99aab5',
      permissions: ['send_messages', 'read_messages']
    }]]),
    channels: [],
    bans: new Map(),
    mutes: new Map(),
    description: '',
    createdAt: new Date(),
    verification_level: 'low',
    content_filter: 'none',
    default_notifications: 'all_messages'
  };

  servers.set(serverId, server);
  res.json(server);
});

app.get('/api/servers/:serverId/channels', verifyToken, (req, res) => {
  const chans = Array.from(channels.values()).filter(c => c.serverId === req.params.serverId);
  res.json(chans);
});

app.post('/api/channels', verifyToken, (req, res) => {
  const { serverId, name, type, topic } = req.body;
  const server = servers.get(serverId);

  if (!server || server.owner !== req.userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const channelId = `ch_${++idCounters.channel}`;
  const channel = {
    id: channelId,
    serverId,
    name,
    type,
    topic: topic || '',
    nsfw: false,
    rateLimit: 0,
    permissions: [],
    createdAt: new Date(),
    archived: false
  };

  channels.set(channelId, channel);
  messages.set(channelId, []);
  server.channels.push(channelId);
  res.json(channel);
});

// Messages API
app.get('/api/messages/:channelId', (req, res) => {
  const msgs = messages.get(req.params.channelId) || [];
  res.json(msgs.slice(-50)); // Last 50 messages
});

app.post('/api/messages/:channelId/search', (req, res) => {
  const { query } = req.body;
  const msgs = messages.get(req.params.channelId) || [];
  const results = msgs.filter(m =>
    m.text.toLowerCase().includes(query.toLowerCase()) ||
    m.username.toLowerCase().includes(query.toLowerCase())
  );
  res.json(results);
});

// Invite API
app.post('/api/servers/:serverId/invites', verifyToken, (req, res) => {
  const server = servers.get(req.params.serverId);
  if (!server || server.owner !== req.userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const inviteId = `inv_${++idCounters.invite}`;
  const invite = {
    id: inviteId,
    serverId: req.params.serverId,
    code: Math.random().toString(36).substr(2, 8),
    creator: req.userId,
    uses: 0,
    maxUses: 0,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date()
  };

  invites.set(inviteId, invite);
  res.json(invite);
});

app.post('/api/invites/:code/accept', verifyToken, (req, res) => {
  const invite = Array.from(invites.values()).find(i => i.code === req.params.code);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });

  const server = servers.get(invite.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
    return res.status(400).json({ error: 'Invite expired' });
  }

  server.members.set(req.userId, { role: 'member', joinedAt: new Date() });
  invite.uses++;

  res.json({ message: 'Joined server', server });
});

// Socket.io Events
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  let socketUser = null;

  socket.on('user_join', (data) => {
    const { token } = data;

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socketUser = {
        userId: decoded.userId,
        email: decoded.email,
        socketId: socket.id
      };

      users.set(socket.id, socketUser);
      socket.join(decoded.userId);

      io.emit('user_online', {
        userId: decoded.userId,
        profile: userProfiles.get(decoded.userId)
      });
    } catch (err) {
      socket.emit('auth_error', 'Invalid token');
    }
  });

  socket.on('create_server', (data) => {
    if (!socketUser) return;

    const serverId = `srv_${++idCounters.server}`;
    const defaultRoleId = `role_${++idCounters.role}`;

    const server = {
      id: serverId,
      name: data.name,
      icon: data.icon || '🎮',
      owner: socketUser.userId,
      members: new Map([[socketUser.userId, { role: 'owner', joinedAt: new Date() }]]),
      roles: new Map([[defaultRoleId, {
        id: defaultRoleId,
        name: '@everyone',
        color: '#99aab5',
        permissions: ['send_messages', 'read_messages']
      }]]),
      channels: [],
      bans: new Map(),
      mutes: new Map(),
      description: '',
      createdAt: new Date()
    };

    servers.set(serverId, server);

    // Create default channel
    const channelId = `ch_${++idCounters.channel}`;
    channels.set(channelId, {
      id: channelId,
      serverId,
      name: 'general',
      type: 'text',
      topic: 'General discussion',
      nsfw: false
    });
    messages.set(channelId, []);
    server.channels.push(channelId);

    socket.emit('server_created', server);
  });

  socket.on('create_channel', (data) => {
    if (!socketUser) return;

    const server = servers.get(data.serverId);
    if (!server || server.owner !== socketUser.userId) return;

    const channelId = `ch_${++idCounters.channel}`;
    const channel = {
      id: channelId,
      serverId: data.serverId,
      name: data.name,
      type: data.type,
      topic: data.topic || '',
      nsfw: data.nsfw || false,
      rateLimit: 0,
      createdAt: new Date()
    };

    channels.set(channelId, channel);
    messages.set(channelId, []);
    server.channels.push(channelId);

    io.emit('channel_created', channel);
  });

  socket.on('join_channel', (channelId) => {
    socket.join(channelId);
  });

  socket.on('send_message', (data) => {
    if (!socketUser) return;

    const messageId = `msg_${++idCounters.message}`;
    const messageData = {
      id: messageId,
      channelId: data.channelId,
      userId: socketUser.userId,
      username: userProfiles.get(socketUser.userId)?.username,
      text: sanitizeText(data.text),
      image: data.image || null,
      files: data.files || [],
      timestamp: new Date().toISOString(),
      reactions: {},
      edited: false,
      editedAt: null,
      pins: 0,
      replies: [],
      mentions: extractMentions(data.text),
      embeds: [],
      deleteScheduledAt: null
    };

    if (!messages.has(data.channelId)) {
      messages.set(data.channelId, []);
    }
    messages.get(data.channelId).push(messageData);

    io.to(data.channelId).emit('new_message', messageData);

    // Notify mentioned users
    messageData.mentions.forEach(userId => {
      io.to(userId).emit('notification', {
        type: 'mention',
        from: socketUser.userId,
        messageId: messageId,
        channelId: data.channelId
      });
    });
  });

  socket.on('edit_message', (data) => {
    if (!socketUser) return;

    const msgs = messages.get(data.channelId);
    const msg = msgs?.find(m => m.id === data.messageId);

    if (msg && msg.userId === socketUser.userId) {
      msg.text = sanitizeText(data.text);
      msg.edited = true;
      msg.editedAt = new Date().toISOString();
      io.to(data.channelId).emit('message_edited', msg);
    }
  });

  socket.on('delete_message', (data) => {
    if (!socketUser) return;

    const msgs = messages.get(data.channelId);
    const index = msgs?.findIndex(m => m.id === data.messageId);

    if (index !== -1) {
      const msg = msgs[index];
      if (msg.userId === socketUser.userId) {
        msgs.splice(index, 1);
        io.to(data.channelId).emit('message_deleted', data.messageId);
      }
    }
  });

  socket.on('pin_message', (data) => {
    if (!socketUser) return;

    const msgs = messages.get(data.channelId);
    const msg = msgs?.find(m => m.id === data.messageId);

    if (msg) {
      msg.pins++;
      io.to(data.channelId).emit('message_pinned', {
        messageId: data.messageId,
        pins: msg.pins
      });
    }
  });

  socket.on('react_message', (data) => {
    if (!socketUser) return;

    const msgs = messages.get(data.channelId);
    const msg = msgs?.find(m => m.id === data.messageId);

    if (msg) {
      if (!msg.reactions[data.emoji]) {
        msg.reactions[data.emoji] = [];
      }
      if (!msg.reactions[data.emoji].includes(socketUser.userId)) {
        msg.reactions[data.emoji].push(socketUser.userId);
      }
      io.to(data.channelId).emit('message_reacted', msg);
    }
  });

  socket.on('typing', (data) => {
    if (!socketUser) return;
    io.to(data.channelId).emit('user_typing', {
      userId: socketUser.userId,
      username: userProfiles.get(socketUser.userId)?.username
    });
  });

  socket.on('stop_typing', (data) => {
    io.to(data.channelId).emit('user_stop_typing', {
      userId: socketUser.userId
    });
  });

  socket.on('voice_signal', (data) => {
    io.to(data.channelId).emit('voice_signal', {
      from: socketUser.userId,
      signal: data.signal
    });
  });

  socket.on('disconnect', () => {
    if (socketUser) {
      users.delete(socket.id);
      io.emit('user_offline', socketUser.userId);
    }
  });
});

// Utility Functions
function sanitizeText(text) {
  return text.replace(/[<>]/g, '').slice(0, 4000);
}

function extractMentions(text) {
  const matches = text.match(/@[\w]+/g) || [];
  return matches.map(m => m.slice(1));
}

http.listen(PORT, HOST, () => {
  console.log(`Advanced Loop Chat Server running on http://0.0.0.0:${PORT}`);
});
