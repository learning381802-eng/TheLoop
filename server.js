const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Listen on 0.0.0.0 for Codespaces
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Serve static files
app.use(express.static('public'));

// Serve the main chat page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/Index.html');
});

// Store active users
const users = new Map();

// Email validation function
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User joins with email
  socket.on('user_join', (data) => {
    // Validate email
    if (!data.email || !validateEmail(data.email)) {
      socket.emit('login_error', 'Invalid email address');
      return;
    }

    users.set(socket.id, { 
      username: data.username, 
      email: data.email, 
      socketId: socket.id 
    });
    
    // Notify all users about the new user
    io.emit('user_joined', {
      username: data.username,
      message: `${data.username} joined The Loop`,
      timestamp: new Date().toISOString()
    });
    
    // Send updated user list
    io.emit('user_list', Array.from(users.values()));
    console.log(`${data.username} (${data.email}) joined. Total users: ${users.size}`);
  });

  // Chat message
  socket.on('chat message', (data) => {
    const user = users.get(socket.id);
    if (user) {
      io.emit('chat message', {
        username: user.username,
        message: data.message,
        timestamp: new Date().toISOString()
      });
      console.log(`Message from ${user.username}: ${data.message}`);
    }
  });

  // Private message
  socket.on('private message', (data) => {
    const sender = users.get(socket.id);
    if (sender && data.recipientId) {
      io.to(data.recipientId).emit('private message', {
        from: sender.username,
        message: data.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Typing indicator
  socket.on('typing', (username) => {
    socket.broadcast.emit('user_typing', username);
  });

  socket.on('stop_typing', () => {
    socket.broadcast.emit('user_stop_typing');
  });

  // User disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      io.emit('user_left', {
        username: user.username,
        message: `${user.username} left The Loop`,
        timestamp: new Date().toISOString()
      });
      io.emit('user_list', Array.from(users.values()));
      console.log(`${user.username} disconnected. Total users: ${users.size}`);
    }
  });
});

// Listen on 0.0.0.0 to accept external connections
http.listen(PORT, HOST, () => {
  console.log(`The Loop Chat Server running on http://0.0.0.0:${PORT}`);
  console.log(`Access it via the Codespace URL provided by GitHub`);
});
