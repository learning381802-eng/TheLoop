const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/Index.html');
});

// In-memory storage
const users = new Map();
const servers = new Map();
const channels = new Map();
const messages = new Map();
const userProfiles = new Map();
let serverCounter = 0;
let channelCounter = 0;
let messageCounter = 0;

// API Routes
app.get('/api/users/:userId', (req, res) => {
  const profile = userProfiles.get(req.params.userId);
  res.json(profile || {});
});

app.post('/api/users/:userId/profile', (req, res) => {
  const { username, bio, avatar, status } = req.body;
  const profile = userProfiles.get(req.params.userId) || {};
  Object.assign(profile, { username, bio, avatar, status });
  userProfiles.set(req.params.userId, profile);
  res.json(profile);
});

app.get('/api/servers', (req, res) => {
  res.json(Array.from(servers.values()));
});

app.post('/api/servers', (req, res) => {
  const { name, owner } = req.body;
  const serverId = `srv_${++serverCounter}`;
  const server = {
    id: serverId,
    name,
    owner,
    members: [owner],
    icon: null,
    createdAt: new Date(),
    roles: []
  };
  servers.set(serverId, server);
  res.json(server);
});

app.get('/api/servers/:serverId/channels', (req, res) => {
  const chans = Array.from(channels.values()).filter(c => c.serverId === req.params.serverId);
  res.json(chans);
});

app.post('/api/channels', (req, res) => {
  const { serverId, name, type } = req.body;
  const channelId = `ch_${++channelCounter}`;
  const channel = {
    id: channelId,
    serverId,
    name,
    type, // 'text' or 'voice'
    topic: '',
    createdAt: new Date()
  };
  channels.set(channelId, channel);
  messages.set(channelId, []);
  res.json(channel);
});

app.get('/api/messages/:channelId', (req, res) => {
  const msgs = messages.get(req.params.channelId) || [];
  res.json(msgs);
});

// Socket.io
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('user_join', (data) => {
    const { email, username } = data;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      socket.emit('login_error', 'Invalid email');
      return;
    }

    const userId = email.replace(/[^a-zA-Z0-9]/g, '_');
    users.set(socket.id, {
      userId,
      username,
      email,
      socketId: socket.id,
      status: 'online'
    });

    if (!userProfiles.has(userId)) {
      userProfiles.set(userId, {
        userId,
        username,
        email,
        bio: '',
        avatar: null,
        status: 'online',
        createdAt: new Date()
      });
    }

    socket.join(userId);
    io.emit('user_online', users.get(socket.id));
    io.emit('user_list', Array.from(users.values()));
  });

  socket.on('create_server', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const serverId = `srv_${++serverCounter}`;
    const server = {
      id: serverId,
      name: data.name,
      owner: user.userId,
      members: [user.userId],
      icon: null,
      roles: []
    };

    servers.set(serverId, server);

    // Create default #general channel
    const channelId = `ch_${++channelCounter}`;
    channels.set(channelId, {
      id: channelId,
      serverId,
      name: 'general',
      type: 'text',
      topic: 'General discussion'
    });
    messages.set(channelId, []);

    socket.emit('server_created', server);
  });

  socket.on('create_channel', (data) => {
    const { serverId, name, type } = data;
    const channelId = `ch_${++channelCounter}`;
    const channel = {
      id: channelId,
      serverId,
      name,
      type,
      topic: ''
    };
    channels.set(channelId, channel);
    messages.set(channelId, []);
    io.emit('channel_created', channel);
  });

  socket.on('join_channel', (channelId) => {
    socket.join(channelId);
  });

  socket.on('send_message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const messageId = `msg_${++messageCounter}`;
    const messageData = {
      id: messageId,
      channelId: data.channelId,
      userId: user.userId,
      username: user.username,
      text: data.text,
      image: data.image || null,
      timestamp: new Date().toISOString(),
      reactions: {},
      edited: false,
      replies: [],
      mentions: data.mentions || []
    };

    if (!messages.has(data.channelId)) {
      messages.set(data.channelId, []);
    }
    messages.get(data.channelId).push(messageData);

    io.to(data.channelId).emit('new_message', messageData);
  });

  socket.on('edit_message', (data) => {
    const msgs = messages.get(data.channelId);
    const msg = msgs.find(m => m.id === data.messageId);
    if (msg) {
      msg.text = data.text;
      msg.edited = true;
      io.to(data.channelId).emit('message_edited', msg);
    }
  });

  socket.on('delete_message', (data) => {
    const msgs = messages.get(data.channelId);
    const index = msgs.findIndex(m => m.id === data.messageId);
    if (index !== -1) {
      msgs.splice(index, 1);
      io.to(data.channelId).emit('message_deleted', data.messageId);
    }
  });

  socket.on('react_message', (data) => {
    const msgs = messages.get(data.channelId);
    const msg = msgs.find(m => m.id === data.messageId);
    if (msg) {
      const user = users.get(socket.id);
      if (!msg.reactions[data.emoji]) {
        msg.reactions[data.emoji] = [];
      }
      if (!msg.reactions[data.emoji].includes(user.userId)) {
        msg.reactions[data.emoji].push(user.userId);
      }
      io.to(data.channelId).emit('message_reacted', msg);
    }
  });

  socket.on('typing', (data) => {
    const user = users.get(socket.id);
    if (user) {
      io.to(data.channelId).emit('user_typing', {
        channelId: data.channelId,
        username: user.username,
        userId: user.userId
      });
    }
  });

  socket.on('stop_typing', (data) => {
    io.to(data.channelId).emit('user_stop_typing', {
      channelId: data.channelId
    });
  });

  socket.on('update_profile', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const profile = userProfiles.get(user.userId) || {};
    Object.assign(profile, data);
    userProfiles.set(user.userId, profile);

    io.emit('profile_updated', {
      userId: user.userId,
      profile
    });
  });

  socket.on('set_status', (status) => {
    const user = users.get(socket.id);
    if (user) {
      user.status = status;
      io.emit('user_status_changed', {
        userId: user.userId,
        status
      });
    }
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      io.emit('user_offline', user.userId);
      io.emit('user_list', Array.from(users.values()));
    }
  });
});

http.listen(PORT, HOST, () => {
  console.log(`The Loop Chat Server running on http://0.0.0.0:${PORT}`);
});
