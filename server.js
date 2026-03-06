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

// In-memory storage (replace with database for production)
const users = new Map();
const conversations = new Map();
const messages = new Map();
let conversationCounter = 0;

// User profiles storage
const userProfiles = new Map();

// Routes for API endpoints
app.get('/api/users/:userId', (req, res) => {
  const profile = userProfiles.get(req.params.userId);
  if (profile) {
    res.json(profile);
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.post('/api/users/:userId/profile', (req, res) => {
  const { bio, avatar } = req.body;
  const profile = userProfiles.get(req.params.userId) || {};
  profile.bio = bio;
  profile.avatar = avatar;
  userProfiles.set(req.params.userId, profile);
  res.json(profile);
});

app.get('/api/conversations', (req, res) => {
  res.json(Array.from(conversations.values()));
});

app.post('/api/conversations', (req, res) => {
  const { name, members, isGroup } = req.body;
  const convId = `conv_${++conversationCounter}`;
  const conversation = {
    id: convId,
    name,
    members,
    isGroup,
    createdAt: new Date(),
    avatar: null
  };
  conversations.set(convId, conversation);
  messages.set(convId, []);
  res.json(conversation);
});

app.get('/api/messages/:conversationId', (req, res) => {
  const msgs = messages.get(req.params.conversationId) || [];
  res.json(msgs);
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User joins
  socket.on('user_join', (data) => {
    const { email, username } = data;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      socket.emit('login_error', 'Invalid email address');
      return;
    }

    const userId = email.replace(/[^a-zA-Z0-9]/g, '_');
    users.set(socket.id, {
      userId,
      username,
      email,
      socketId: socket.id
    });

    // Initialize user profile if doesn't exist
    if (!userProfiles.has(userId)) {
      userProfiles.set(userId, {
        userId,
        username,
        email,
        bio: '',
        avatar: null,
        createdAt: new Date()
      });
    }

    socket.join(userId);
    io.emit('user_online', {
      userId,
      username,
      email
    });

    io.emit('user_list', Array.from(users.values()));
    console.log(`${username} (${email}) joined. Total users: ${users.size}`);
  });

  // Send message
  socket.on('send_message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const messageData = {
      id: `msg_${Date.now()}_${Math.random()}`,
      conversationId: data.conversationId,
      userId: user.userId,
      username: user.username,
      text: data.text,
      image: data.image || null,
      timestamp: new Date().toISOString(),
      reactions: []
    };

    // Store message
    if (!messages.has(data.conversationId)) {
      messages.set(data.conversationId, []);
    }
    messages.get(data.conversationId).push(messageData);

    // Emit to all members in conversation
    const conversation = conversations.get(data.conversationId);
    if (conversation) {
      conversation.members.forEach(memberId => {
        io.to(memberId).emit('new_message', messageData);
      });
    }
  });

  // Create group chat
  socket.on('create_group', (data) => {
    const { name, members } = data;
    const user = users.get(socket.id);

    if (!user) return;

    const convId = `conv_${++conversationCounter}`;
    const conversation = {
      id: convId,
      name,
      members: [...new Set([user.userId, ...members])],
      isGroup: true,
      createdAt: new Date(),
      avatar: null
    };

    conversations.set(convId, conversation);
    messages.set(convId, []);

    // Notify all group members
    conversation.members.forEach(memberId => {
      io.to(memberId).emit('group_created', conversation);
    });
  });

  // Start direct message
  socket.on('start_dm', (data) => {
    const user = users.get(socket.id);
    const { recipientId } = data;

    if (!user) return;

    // Create DM conversation ID (sorted for consistency)
    const dmId = [user.userId, recipientId].sort().join('_dm_');

    if (!conversations.has(dmId)) {
      const conversation = {
        id: dmId,
        name: null,
        members: [user.userId, recipientId],
        isGroup: false,
        createdAt: new Date()
      };
      conversations.set(dmId, conversation);
      messages.set(dmId, []);
    }

    socket.emit('dm_opened', conversations.get(dmId));
  });

  // Update user profile
  socket.on('update_profile', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const profile = userProfiles.get(user.userId) || {};
    profile.bio = data.bio;
    if (data.avatar) profile.avatar = data.avatar;
    profile.username = data.username;

    userProfiles.set(user.userId, profile);

    // Update in users list
    user.username = data.username;

    io.emit('profile_updated', {
      userId: user.userId,
      profile
    });
  });

  // Typing indicator
  socket.on('typing', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const conversation = conversations.get(data.conversationId);
    if (conversation) {
      conversation.members.forEach(memberId => {
        if (memberId !== user.userId) {
          io.to(memberId).emit('user_typing', {
            conversationId: data.conversationId,
            username: user.username
          });
        }
      });
    }
  });

  socket.on('stop_typing', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const conversation = conversations.get(data.conversationId);
    if (conversation) {
      conversation.members.forEach(memberId => {
        if (memberId !== user.userId) {
          io.to(memberId).emit('user_stop_typing', {
            conversationId: data.conversationId
          });
        }
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      io.emit('user_offline', user.userId);
      io.emit('user_list', Array.from(users.values()));
      console.log(`${user.username} disconnected. Total users: ${users.size}`);
    }
  });
});

http.listen(PORT, HOST, () => {
  console.log(`The Loop Chat Server running on http://0.0.0.0:${PORT}`);
  console.log(`Access it via the Codespace URL provided by GitHub`);
});
