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
    fs.mkdirSync('/tmp/sessions');
}

io.on('connection', (socket) => {
    console.log('নতুন ইউজার যুক্ত হয়েছে:', socket.id);
    let sock = null;
    let pairingRequested = false;

    socket.on('request_pairing_code', async ({ phoneNumber, name }) => {
        try {
            let formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
            console.log(`নম্বর প্রসেস করা হচ্ছে: ${formattedNumber}`);

            const sessionFolder = path.join('/tmp/sessions', formattedNumber);

            // 🚨 কানেকশন এরর ও ক্র্যাশ দূর করতে পূর্বে জমে থাকা ত্রুটিযুক্ত ফাইল সম্পূর্ণ ডিলেট করা
            if (fs.existsSync(sessionFolder)) {
                try {
                    fs.rmSync(sessionFolder, { recursive: true, force: true });
                    console.log(`পুরাতন ত্রুটিযুক্ত সেশন ফোল্ডার রিমুভ করা হয়েছে: ${formattedNumber}`);
                } catch (e) {
                    console.error("ফোল্ডার ডিলিট করতে সমস্যা:", e);
                }
            }

            const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

            sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: ["Chrome (Linux)", "", ""] // পেয়ারিং কোড জেনারেট করার জন্য এটি সবচেয়ে বেশি স্টেবল
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if ((qr || connection === 'connecting') && !pairingRequested) {
                    pairingRequested = true;
                    try {
                        console.log(`হোয়াটসঅ্যাপ কোড রিকোয়েস্ট করা হচ্ছে...`);
                        const code = await sock.requestPairingCode(formattedNumber);
                        console.log(`সফল কোড: ${code}`);
                        socket.emit('pairing_code', { code: code });
                    } catch (err) {
                        console.error("কোড জেনারেট এরর:", err);
                        socket.emit('error_message', 'কোড জেনারেট করা যায়নি। আবার চেষ্টা করুন।');
                        pairingRequested = false;
                    }
                }
                
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    console.log(`কানেকশন বন্ধ হয়েছে (কোড: ${statusCode})। রিকানেক্ট: ${shouldReconnect}`);
                    
                    // কানেকশন ফেইল হলে সেশন ফোল্ডার ক্লিন করা
                    if (!shouldReconnect) {
                        try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (e) {}
                    }
                    
                    socket.emit('status_update', 'কানেকশন বন্ধ হয়েছে। আবার চেষ্টা করুন।');
                    pairingRequested = false;
                } else if (connection === 'open') {
                    console.log(`✅ সফলভাবে সেশন লিঙ্ক হয়েছে: ${formattedNumber}`);
                    socket.emit('link_success', { phoneNumber: formattedNumber, name });
                }
            });

        } catch (error) {
            console.error('সিস্টেম এরর:', error);
            socket.emit('error_message', 'সার্ভারে সমস্যা হয়েছে।');
        }
    });

    socket.on('disconnect', () => {
        console.log('ইউজার ডিসকানেক্ট হয়েছে');
    });
});

// Blogger API সাপোর্ট
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
