const express = require('express');
const mysql = require('mysql2/promise');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { Server } = require('socket.io');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.static('public'));

// --- DATABASE CONNECTION POOL SETUP ---
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root', 
    password: process.env.DB_PASS || '', 
    database: process.env.DB_NAME || 'asteriskcdrdb',
    waitForConnections: true,
    connectionLimit: 10
});

let activeCalls = {};
let peerStatus = {};

// --- ASTERISK AMI REAL-TIME MONITORING ---
function connectAMI() {
    activeCalls = {};
    peerStatus = {};
    let loggedIn = false;
    let queriedPeers = false;
    const client = net.connect({ port: process.env.AMI_PORT || 5038, host: '127.0.0.1' }, () => {
        client.write(`Action: Login\r\nUsername: ${process.env.AMI_USER}\r\nSecret: ${process.env.AMI_PASS}\r\n\r\n`);
        console.log('AMI: Connection opened, login sent');
    });

    // Fallback: if login detection fails, try SIPpeers anyway after 3s
    setTimeout(() => {
        if (!queriedPeers) {
            console.log('AMI: Login not detected within 3s, sending SIPpeers anyway');
            queriedPeers = true;
            client.write(`Action: SIPpeers\r\n\r\n`);
            setTimeout(() => {
                if (!Object.keys(peerStatus).length) {
                    console.log('AMI: SIPpeers returned nothing, trying PJSIPShowEndpoints');
                    client.write(`Action: PJSIPShowEndpoints\r\n\r\n`);
                }
            }, 3000);
        }
    }, 3000);

    function queryPeerStatus() {
        if (queriedPeers) return;
        queriedPeers = true;
        console.log('AMI: Sending SIPpeers');
        client.write(`Action: SIPpeers\r\n\r\n`);
        setTimeout(() => {
            if (!Object.keys(peerStatus).length) {
                console.log('AMI: SIPpeers returned nothing, trying PJSIPShowEndpoints');
                client.write(`Action: PJSIPShowEndpoints\r\n\r\n`);
            }
        }, 2000);
    }

    let buffer = '';
    client.on('data', (data) => {
        buffer += data.toString();
        let packets = buffer.split('\r\n\r\n');
        buffer = packets.pop();

        packets.forEach(packet => {
            const lines = packet.split('\r\n');
            let event = {};
            lines.forEach(line => {
                const parts = line.split(': ');
                if (parts[0] && parts[1]) event[parts[0].trim()] = parts[1].trim();
            });

            // Detect successful login from Response or FullyBooted event
            if (!loggedIn) {
                if (event.Response === 'Success' || event.Event === 'FullyBooted') {
                    console.log('AMI: Login detected');
                    loggedIn = true;
                    queryPeerStatus();
                }
            }

            // Parse SIPpeers peer list entries
            if (event.Event === 'PeerEntry') {
                let name = event.ObjectName || '';
                let status = event.Status || '';
                if (name && status.startsWith('OK')) {
                    peerStatus[name] = true;
                }
            }

            // Parse PJSIPShowEndpoints endpoint entries
            if (event.Event === 'EndpointList') {
                let name = event.ObjectName || '';
                if (name) {
                    if (event.DeviceState === '1' || event.DeviceState === '0') {
                        peerStatus[name] = event.DeviceState === '1';
                    } else {
                        peerStatus[name] = true;
                    }
                }
            }

            // Emit peerStatus once initial list queries complete
            if (event.Event === 'PeerlistComplete' || event.Event === 'EndpointListComplete') {
                console.log('AMI: Peer list complete, peers:', Object.keys(peerStatus));
                io.emit('peerStatus', peerStatus);
            }

            // Real-time peer registration changes
            if (event.Event === 'PeerStatus') {
                let name = event.Peer ? event.Peer.replace(/^(SIP|PJSIP)\//, '') : '';
                if (name) {
                    peerStatus[name] = event.PeerStatus === 'Registered' || event.PeerStatus === 'Reachable';
                    io.emit('peerStatus', peerStatus);
                }
            }

            // New channel = new call, always fresh timestamp
            if (event.Event === 'Newchannel') {
                let exten = event.CallerIDNum;
                let connectedLine = event.ConnectedLineNum || '';
                if (exten && exten.length <= 5) {
                    activeCalls[exten] = {
                        state: 'Ringing',
                        partner: connectedLine && connectedLine !== '<unknown>' ? connectedLine : 'Connecting...',
                        start: Date.now()
                    };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // State updates for existing calls — update partner and preserve start time
            if (event.Event === 'Newstate') {
                let exten = event.CallerIDNum;
                let connectedLine = event.ConnectedLineNum || '';
                if (exten && exten.length <= 5) {
                    let calculatedState = 'Ringing';
                    if (event.ChannelStateDesc === 'Up' || event.ChannelState === '6') {
                        calculatedState = 'In Call';
                    } else if (activeCalls[exten]?.state === 'In Call') {
                        calculatedState = 'In Call';
                    }
                    let existing = activeCalls[exten];
                    let partner = existing?.partner || 'Connecting...';
                    if (connectedLine && connectedLine !== '<unknown>') partner = connectedLine;
                    let start = Date.now();
                    if (existing && existing.start) {
                        let age = Date.now() - existing.start;
                        start = age < 60000 && age >= 0 ? existing.start : Date.now();
                    }
                    activeCalls[exten] = { state: calculatedState, partner, start };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Fallback catching: Ensure bridge entrances catch linked channel audio paths
            if (event.Event === 'BridgeEnter') {
                let exten = event.CallerIDNum;
                if (exten && activeCalls[exten]) {
                    activeCalls[exten].state = 'In Call';
                    let age = Date.now() - activeCalls[exten].start;
                    if (age >= 60000 || age < 0) activeCalls[exten].start = Date.now();
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Clean tear down when either party terminates the call
            if (event.Event === 'Hangup') {
                let exten = event.CallerIDNum;
                if (exten && activeCalls[exten]) {
                    delete activeCalls[exten];
                    io.emit('callUpdate', { extension: exten, callData: null });
                }
            }
        });
    });

    client.on('error', (err) => { console.error('AMI Error:', err.message); });
    client.on('close', () => { setTimeout(connectAMI, 5000); });
}
connectAMI();

// Periodic cleanup of stale call entries (older than 60 seconds)
setInterval(() => {
    let now = Date.now();
    for (let ext in activeCalls) {
        let age = now - (activeCalls[ext].start || 0);
        if (age >= 60000 || age < 0) delete activeCalls[ext];
    }
}, 30000);

io.on('connection', (socket) => {
    let clean = {};
    let now = Date.now();
    for (let ext in activeCalls) {
        let age = now - (activeCalls[ext].start || 0);
        if (age < 60000 && age >= 0) clean[ext] = activeCalls[ext];
    }
    socket.emit('initialState', clean);
    socket.emit('peerStatus', peerStatus);
});

// System Shared Middleware to fetch extension rosters and handle language toggles
app.use(async (req, res, next) => {
    try {
        const [roster] = await pool.query("SELECT extension, name FROM asterisk.users ORDER BY extension ASC");
        let onlineMap = {};
        for (let e of roster) {
            let online = peerStatus[e.extension] || false;
            if (activeCalls[e.extension]) online = true;
            onlineMap[e.extension] = online;
        }
        if (Object.values(onlineMap).every(v => !v)) {
            const dbQueries = [
                "SELECT DISTINCT id FROM sip WHERE keyword='host' AND data IS NOT NULL AND data != ''",
                "SELECT id, data FROM sip WHERE keyword='ipaddr' AND data IS NOT NULL AND data != '' AND data != 'dynamic' AND data != '-none-'",
                "SELECT name, ipaddr FROM asterisk.sipfriends WHERE ipaddr IS NOT NULL AND ipaddr != ''",
                "SELECT name, ipaddr FROM asterisk.sippeers WHERE ipaddr IS NOT NULL AND ipaddr != ''",
                "SELECT id, ipaddr FROM asterisk.ps_endpoints WHERE ipaddr IS NOT NULL AND ipaddr != ''"
            ];
            for (const q of dbQueries) {
                try {
                    const [peers] = await pool.query(q);
                    if (peers && peers.length) {
                        peers.forEach(p => {
                            const key = p.name || p.id;
                            if (key) { onlineMap[key] = true; peerStatus[key] = true; }
                        });
                        break;
                    }
                } catch (_) { }
            }
            if (Object.keys(peerStatus).length) console.log('DB fallback found peers:', Object.keys(peerStatus));
        }
        res.locals.roster = roster.map(emp => ({ ...emp, online: onlineMap[emp.extension] || false }));
        res.locals.activeCalls = activeCalls;
        res.locals.currentPage = req.path;
        res.locals.currentLang = req.query.lang === 'ar' ? 'ar' : 'en';
        next();
    } catch (err) { next(err); }
});

// --- ROUTE 1: CDR DETAILS VIEW ---
app.get('/', (req, res) => res.redirect('/cdr'));
app.get('/cdr', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const selectedExtension = req.query.targetExtension || 'ALL';
        const statusFilter = req.query.statusFilter || 'ALL';
        const searchSrc = req.query.searchSrc || '';
        const searchDst = req.query.searchDst || '';

        let query = `
            SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, c.disposition, c.uniqueid, c.recordingfile
            FROM asteriskcdrdb.cdr c
            WHERE c.calldate BETWEEN ? AND ?
        `;
        let queryParams = [startDate, endDate];

        if (selectedExtension !== 'ALL') { 
            query += " AND (c.src = ? OR c.dst = ?)"; 
            queryParams.push(selectedExtension, selectedExtension); 
        }
        if (searchSrc) { 
            query += " AND c.src LIKE ?"; 
            queryParams.push(`%${searchSrc}%`); 
        }
        if (searchDst) { 
            query += " AND c.dst LIKE ?"; 
            queryParams.push(`%${searchDst}%`); 
        }
        if (statusFilter !== 'ALL') { 
            query += " AND TRIM(UPPER(c.disposition)) = TRIM(UPPER(?))"; 
            queryParams.push(statusFilter); 
        }

        query += " ORDER BY c.calldate DESC LIMIT 2000";
        const [rows] = await pool.query(query, queryParams);

        res.render('cdr', {
            calls: rows,
            filters: { startDate, endDate, targetExtension: selectedExtension, statusFilter, searchSrc, searchDst },
            moment
        });
    } catch (error) { res.status(500).send("CDR System Error: " + error.message); }
});

// --- ROUTE 2: EMPLOYEE SUMMARY ANALYTICS VIEW ---
app.get('/employees', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');

        const [rows] = await pool.query("SELECT src, dst, billsec, disposition, channel, dstchannel FROM asteriskcdrdb.cdr WHERE calldate BETWEEN ? AND ?", [startDate, endDate]);

        const employeeMetrics = {};
        res.locals.roster.forEach(emp => {
            employeeMetrics[emp.extension] = { 
                extension: emp.extension, 
                name: emp.name, 
                totalCalls: 0, 
                inboundTalkSec: 0, 
                outboundTalkSec: 0, 
                uniqueNumbers: new Set() 
            };
        });

        rows.forEach(row => {
            const sec = parseInt(row.billsec) || 0;
            const isOutbound = row.channel.toUpperCase().includes('SIP/') && !row.dstchannel.toUpperCase().includes('SIP/');

            if (employeeMetrics[row.src]) {
                employeeMetrics[row.src].totalCalls++;
                employeeMetrics[row.src].uniqueNumbers.add(row.dst);
                if (row.disposition === 'ANSWERED') {
                    if (isOutbound) employeeMetrics[row.src].outboundTalkSec += sec;
                    else employeeMetrics[row.src].inboundTalkSec += sec;
                }
            }
            if (employeeMetrics[row.dst]) {
                employeeMetrics[row.dst].totalCalls++;
                employeeMetrics[row.dst].uniqueNumbers.add(row.src);
                if (row.disposition === 'ANSWERED') {
                    if (isOutbound) employeeMetrics[row.dst].outboundTalkSec += sec;
                    else employeeMetrics[row.dst].inboundTalkSec += sec;
                }
            }
        });

        res.render('employees', {
            employeeMetrics: Object.values(employeeMetrics),
            filters: { startDate, endDate },
            moment
        });
    } catch (error) { res.status(500).send("Employee Analytics Error: " + error.message); }
});

// --- ROUTE 3: DEDICATED LIVE OPERATOR PANEL VIEW ---
app.get('/operator', (req, res) => {
    try {
        res.render('operator', { moment });
    } catch (error) { res.status(500).send("Operator Panel Engine Error: " + error.message); }
});

// --- ROUTE 4: DOWNLOAD PIPELINE ---
app.get('/download-audio', async (req, res) => {
    try {
        const { uniqueid } = req.query;
        const [rows] = await pool.query("SELECT calldate, recordingfile FROM cdr WHERE uniqueid = ? LIMIT 1", [uniqueid]);
        if (!rows.length || !rows[0].recordingfile) return res.status(404).send("Audio track not documented.");

        const callDate = moment(rows[0].calldate);
        const filename = rows[0].recordingfile;
        const pathsToSearch = [
            `/var/spool/asterisk/monitor/${callDate.format('YYYY')}/${callDate.format('MM')}/${callDate.format('DD')}/${filename}`,
            `/var/spool/asterisk/monitor/${filename}`
        ];

        let targetPath = null;
        for (const p of pathsToSearch) { if (fs.existsSync(p)) { targetPath = p; break; } }
        if (!targetPath) return res.status(404).send("Audio file missing from server disks.");

        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.setHeader('Content-Type', 'audio/wav');
        fs.createReadStream(targetPath).pipe(res);
    } catch (err) { res.status(500).send("Audio System Error: " + err.message); }
});

server.listen(PORT, () => console.log(`Real-Time Enterprise Engine active on port ${PORT}`));
