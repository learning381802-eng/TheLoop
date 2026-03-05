const http = require('http');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Vanilla Chat</title></head>
        <body style="font-family:sans-serif; padding:20px;">
            <h2>The Loop: Vanilla Edition</h2>
            <div id="chat" style="border:1px solid #ccc; height:300px; overflow-y:scroll; margin-bottom:10px; padding:10px;"></div>
            <input id="msg" placeholder="Type here..."><button onclick="send()">Send</button>
            <script>
                const ws = new WebSocket('ws://' + location.host);
                ws.onmessage = (e) => {
                    const div = document.createElement('div');
                    div.textContent = e.data;
                    document.getElementById('chat').appendChild(div);
                };
                function send() {
                    const input = document.getElementById('msg');
                    ws.send(input.value);
                    input.value = '';
                }
            </script>
        </body>
        </html>
    `);
});

server.on('upgrade', (req, socket) => {
    if (req.headers['upgrade'] !== 'websocket') return socket.end();

    // Native WebSocket Handshake
    const key = req.headers['sec-websocket-key'];
    const hash = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                 'Upgrade: websocket\r\n' +
                 'Connection: Upgrade\r\n' +
                 'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n');

    socket.on('data', (buffer) => {
        // Basic decoding of WebSocket frames (simplified)
        const firstByte = buffer[0];
        const isFinalFrame = Boolean(firstByte & 0x80);
        const opCode = firstByte & 0x0F;
        if (opCode === 0x8) return socket.end(); // Close connection
        
        const secondByte = buffer[1];
        let length = secondByte & 0x7F;
        const mask = buffer.slice(2, 6);
        const data = buffer.slice(6, 6 + length);
        const decoded = Buffer.from(data.map((byte, i) => byte ^ mask[i % 4])).toString();
        
        // Broadcast to this socket (for a real broadcast, you'd track all sockets in an array)
        socket.write(constructReply(decoded));
    });
});

function constructReply(text) {
    const json = Buffer.from(text);
    const length = json.length;
    return Buffer.concat([Buffer.from([0x81, length]), json]);
}

server.listen(3000, () => console.log('Server at http://localhost:3000'));
