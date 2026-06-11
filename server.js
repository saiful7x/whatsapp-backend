const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Blogger থেকে Socket কানেকশন আসার জন্য CORS অনুমোদন
const io = new Server(server, { 
    cors: { 
        origin: "*", 
        methods: ["GET", "POST", "DELETE"]
    } 
});

if (!fs.existsSync('/tmp/sessions')) {
    fs.mkdirSync('/tmp/sessions'); // Render-এর ফ্রী টায়ারে রাইট করার জন্য /tmp ফোল্ডার ব্যবহার করা নিরাপদ
}

io.on('connection', (socket) => {
    console.log('নতুন ইউজার যুক্ত হয়েছে:', socket.id);
    let sock = null;
    let pairingRequested = false;

    socket.on('request_pairing_code', async ({ phoneNumber, name }) => {
        try {
            let formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
            if (formattedNumber.startsWith('0')) {
                formattedNumber = '88' + formattedNumber;
            }

            const sessionFolder = path.join('/tmp/sessions', formattedNumber);
            const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

            sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: ["Ubuntu", "Chrome", "20.0.04"] 
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if ((qr || connection === 'connecting') && !pairingRequested) {
                    pairingRequested = true;
                    try {
                        const code = await sock.requestPairingCode(formattedNumber);
                        socket.emit('pairing_code', { code: code });
                    } catch (err) {
                        socket.emit('error_message', 'কোড জেনারেট করা যায়নি। আবার চেষ্টা করুন।');
                        pairingRequested = false;
                    }
                }
                
                if (connection === 'close') {
                    socket.emit('status_update', 'কানেকশন বন্ধ হয়েছে। আবার চেষ্টা করুন।');
                    pairingRequested = false;
                } else if (connection === 'open') {
                    socket.emit('link_success', { phoneNumber: formattedNumber, name });
                }
            });

        } catch (error) {
            socket.emit('error_message', 'সার্ভারে সমস্যা হয়েছে।');
        }
    });
});

// Blogger API সাপোর্ট (CORS header)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

app.get('/api/linked-users', (req, res) => {
    try {
        const folders = fs.readdirSync('/tmp/sessions');
        const activeUsers = folders.map(folder => ({ phone: '+' + folder, linkedAt: new Date() }));
        res.json(activeUsers);
    } catch (e) {
        res.json([]);
    }
});

app.delete('/api/linked-users/:phone', (req, res) => {
    try {
        const phone = req.params.phone.replace(/[^0-9]/g, '');
        const sessionFolder = path.join('/tmp/sessions', phone);
        if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false });
        }
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('সার্ভার সচল আছে');
});
