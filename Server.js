const http = require('http');
const crypto = require('crypto');

// 1. THE UI (HTML/CSS/JS)
const html = `
<!DOCTYPE html>
<html>
<head>
    <title>The Loop</title>
    <style>
        body { font-family: 'Courier New', monospace; background: #111; color: #0f0; display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        #chat { flex-grow: 1; border: 1px solid #0f0; overflow-y: auto; padding: 15px; margin-bottom: 10px; background: #000; }
        .msg { margin-bottom: 8px; border-left: 2px solid #0f0; padding-left: 10px; }
        .system { color: #ff00ff; font-weight: bold; }
        #input-area { display: flex; gap: 10px; }
        input { background: #000; border: 1px solid #0f0; color: #0f0; padding: 10px; flex-grow: 1; outline: none; }
        button { background: #0f0; border: none; padding: 10px 20px; cursor: pointer; font-weight: bold; }
        button:hover { background: #0a0; }
    </style>
</head>
<body>
    <h1>SYSTEM_NAME: THE_LOOP</h1>
    <div id="chat"></div>
    <div id="input-area">
        <input id="msg" placeholder="Type 'start' for the loop..." autocomplete="off">
        <button onclick="send()">SEND</button>
    </div>

    <script>
        const chat = document.getElementById('chat');
        const input = document.getElementById('msg');
        const ws = new WebSocket('ws://' + location.host);

        ws.onmessage = (e) => {
            const div = document.createElement('div');
            div.className = 'msg';
            if (e.data.startsWith('SYSTEM:')) div.classList.add('system');
            div.textContent = e.data;
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
        };

        function send() {
            if (input.value) {
                ws.send(input.value);
                input.value = '';
            }
        }

        input.addEventListener('keypress', (e) => { if(e.key === 'Enter') send(); });
    </script>
</body>
</html>
`;

// 2. THE SERVER LOGIC
const clients = new Set();

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
});

server.on('upgrade', (req, socket) => {
    if (req.headers['upgrade'] !== 'websocket') return socket.end();

    // Handshake
    const key = req.headers['sec-websocket-key'];
    const hash = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                 'Upgrade: websocket\r\n' +
                 'Connection: Upgrade\r\n' +
                 'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n');

    clients.add(socket);

    socket.on('data', (buffer) => {
        const decoded = decodeFrame(buffer);
        if (!decoded) return;

        // THE LOOP FEATURE
        if (decoded.toLowerCase() === 'start') {
            const welcomeMessages = ["Welcome to The Loop.", "Stay connected.", "Everything cycles back."];
            let i = 0;
            const interval = setInterval(() => {
                if (socket.destroyed) return clearInterval(interval);
                socket.write(encodeFrame("SYSTEM: " + welcomeMessages[i]));
                i = (i + 1) % welcomeMessages.length;
            }, 3000);
        } else {
            // Broadcast to everyone
            for (let client of clients) {
                if (!client.destroyed) client.write(encodeFrame("User: " + decoded));
            }
        }
    });

    socket.on('end', () => clients.delete(socket));
});

// Helper functions for raw WebSocket data
function decodeFrame(buffer) {
    const secondByte = buffer[1];
    const length = secondByte & 0x7F;
    const mask = buffer.slice(2, 6);
    const data = buffer.slice(6, 6 + length);
    return data.map((byte, i) => byte ^ mask[i % 4]).toString();
}

function encodeFrame(text) {
    const payload = Buffer.from(text);
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

server.listen(3000, () => console.log('The Loop is running at http://localhost:3000'));
