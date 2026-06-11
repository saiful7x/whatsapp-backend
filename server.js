const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

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

    socket.on('request_pairing_code', async ({ phoneNumber, name }) => {
        try {
            let formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
            console.log(`নম্বর প্রসেস করা হচ্ছে: ${formattedNumber}`);

            const sessionFolder = path.join('/tmp/sessions', formattedNumber);

            // পুরাতন ও ত্রুটিযুক্ত সেশন ফাইল মুছে ফেলা
            if (fs.existsSync(sessionFolder)) {
                try {
                    fs.rmSync(sessionFolder, { recursive: true, force: true });
                    console.log(`পুরাতন সেশন ফোল্ডার রিমুভ করা হয়েছে: ${formattedNumber}`);
                } catch (e) {
                    console.error("ফোল্ডার ডিলিট করতে সমস্যা:", e);
                }
            }

            const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

            // অপ্টিমাইজড সকেট কনফিগারেশন
            sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: Browsers.macOS('Chrome'), // 🚨 মোস্ট ইম্পর্টেন্ট: পেয়ারিং সাকসেস করার জন্য অফিসিয়াল রিকমেন্ডেড ব্রাউজার
                keepAliveIntervalMs: 30000, 
                connectTimeoutMs: 60000, 
                syncFullHistory: false, // ফ্রী সার্ভার ক্র্যাশ এড়াতে হিস্ট্রি সিঙ্ক অফ
                markOnlineOnConnect: true
            });

            sock.ev.on('creds.update', saveCreds);

            // 🚨 নতুন ও স্টেবল পেয়ারিং কোড রিকোয়েস্ট মেথড (৪ সেকেন্ডের ডিলে দিয়ে ফাস্ট-ট্র্যাক রিকোয়েস্ট)
            if (!sock.authState.creds.registered) {
                setTimeout(async () => {
                    try {
                        console.log(`হোয়াটসঅ্যাপ কোড রিকোয়েস্ট করা হচ্ছে...`);
                        const code = await sock.requestPairingCode(formattedNumber);
                        console.log(`সফল পেয়ারিং কোড: ${code}`);
                        socket.emit('pairing_code', { code: code });
                    } catch (err) {
                        console.error("কোড জেনারেট এরর:", err);
                        socket.emit('error_message', 'কোড জেনারেট করা যায়নি। আবার চেষ্টা করুন।');
                    }
                }, 4000); // ৪ সেকেন্ড ডিলে
            }

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    console.log(`কানেকশন বন্ধ হয়েছে (কোড: ${statusCode})। রিকানেক্ট: ${shouldReconnect}`);
                    
                    if (!shouldReconnect) {
                        try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (e) {}
                    }
                    
                    socket.emit('status_update', 'কানেকশন বন্ধ হয়েছে। আবার চেষ্টা করুন।');
                } else if (connection === 'open') {
                    console.log(`✅ সফল সেশন লিঙ্কড: ${formattedNumber}`);
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

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// 📩 লিঙ্কড হওয়া যেকোনো নম্বর থেকে মেসেজ পাঠানোর API
app.get('/send', async (req, res) => {
    const from = req.query.from; // যে অ্যাকাউন্ট লিঙ্ক করেছেন (যেমন: 8801333961696)
    const to = req.query.to;     // যাকে মেসেজ পাঠাবেন (যেমন: 88017XXXXXXXX)
    const message = req.query.message; // মেসেজ টেক্সট

    if (!from || !to || !message) {
        return res.status(400).json({ error: 'from, to, and message are required. Example: /send?from=8801333961696&to=8801700000000&message=Hello' });
    }

    const cleanFrom = from.replace(/[^0-9]/g, '');
    let cleanTo = to.replace(/[^0-9]/g, '');
    if (!cleanTo.endsWith('@s.whatsapp.net')) {
        cleanTo = cleanTo + '@s.whatsapp.net';
    }

    const sessionFolder = path.join('/tmp/sessions', cleanFrom);
    if (!fs.existsSync(sessionFolder)) {
        return res.status(404).json({ error: 'Sender session not found or not linked yet' });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const client = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' })
        });

        client.ev.on('creds.update', saveCreds);

        client.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                await client.sendMessage(cleanTo, { text: message });
                client.end(); // মেসেজ পাঠানোর পর কানেকশন বন্ধ হবে
                return res.json({ success: true, message: 'Message sent successfully!' });
            }
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
