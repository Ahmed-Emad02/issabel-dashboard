const express = require('express');
const mysql = require('mysql2/promise');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { exec } = require('child_process');
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
let dongleStatus = [];


// --- CHAN_DONGLE STATUS MONITOR ---
function parseDongleDevices(output) {
    const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const headerIndex = lines.findIndex(l => l.startsWith('ID') && l.includes('State') && l.includes('IMEI'));
    if (headerIndex === -1) return [];

    return lines.slice(headerIndex + 1).map(line => {
        // chan_dongle output is column based, but Provider Name can contain spaces.
        const parts = line.split(/\s+/);
        if (parts.length < 4) return null;

        const id = parts[0] || '';
        const group = parts[1] || '';
        let state = parts[2] || '';
        let idx = 3;
        if (parts[2] === 'Not' && parts[3] === 'connec') { state = 'Not connected'; idx = 4; }
        if (parts[2] === 'GSM' && parts[3] === 'not' && parts[4] === 're') { state = 'GSM not registered'; idx = 5; }

        const rssi = parts[idx++] || '0';
        const mode = parts[idx++] || '0';
        const submode = parts[idx++] || '0';

        // Last 5 columns are normally Model, Firmware, IMEI, IMSI, Number.
        const tail = parts.slice(idx);
        let number = tail.length ? tail[tail.length - 1] : 'Unknown';
        let imsi = tail.length > 1 ? tail[tail.length - 2] : '';
        let imei = tail.length > 2 ? tail[tail.length - 3] : '';
        let firmware = tail.length > 3 ? tail[tail.length - 4] : '';
        let model = tail.length > 4 ? tail[tail.length - 5] : '';
        let provider = tail.length > 5 ? tail.slice(0, tail.length - 5).join(' ') : 'NONE';

        if (!number || number === '') number = 'Unknown';
        if (!provider || provider === '') provider = 'NONE';

        return { id, group, state, rssi, mode, submode, provider, model, firmware, imei, imsi, number };
    }).filter(Boolean);
}

function refreshDongleStatus() {
    exec('/usr/sbin/asterisk -rx "dongle show devices"', { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
            dongleStatus = [{ id: 'chan_dongle', group: '-', state: 'Unavailable', rssi: '0', mode: '-', submode: '-', provider: stderr || err.message, model: '', firmware: '', imei: '', imsi: '', number: 'Unknown' }];
        } else {
            dongleStatus = parseDongleDevices(stdout);
        }
        io.emit('dongleStatus', dongleStatus);
    });
}
setInterval(refreshDongleStatus, 10000);
setTimeout(refreshDongleStatus, 2000);

// --- FIXED ASTERISK AMI REAL-TIME MONITORING ---
function connectAMI() {
    activeCalls = {};
    peerStatus = {};
    const client = net.connect({ port: process.env.AMI_PORT || 5038, host: '127.0.0.1' }, () => {
        client.write(`Action: Login\r\nUsername: ${process.env.AMI_USER}\r\nSecret: ${process.env.AMI_PASS}\r\n\r\n`);
    });

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

            // Real-time peer registration changes
            if (event.Event === 'PeerStatus') {
                let name = event.Peer ? event.Peer.replace(/^(SIP|PJSIP)\//, '') : '';
                if (name) {
                    peerStatus[name] = event.PeerStatus === 'Registered';
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
    socket.emit('dongleStatus', dongleStatus);
});

// System Shared Middleware to fetch extension rosters and handle language toggles
app.use(async (req, res, next) => {
    try {
        const [roster] = await pool.query("SELECT extension, name FROM asterisk.users ORDER BY extension ASC");
        let onlineMap = {};
        for (let e of roster) onlineMap[e.extension] = peerStatus[e.extension] || false;
        if (Object.values(onlineMap).every(v => !v)) {
            try {
                const [peers] = await pool.query("SELECT name, ipaddr FROM asterisk.sipfriends WHERE ipaddr IS NOT NULL AND ipaddr != ''");
                if (peers.length) peers.forEach(p => { onlineMap[p.name] = true; });
            } catch (_) {
                try {
                    const [peers] = await pool.query("SELECT name, ipaddr FROM asterisk.sippeers WHERE ipaddr IS NOT NULL AND ipaddr != ''");
                    if (peers.length) peers.forEach(p => { onlineMap[p.name] = true; });
                } catch (_2) { }
            }
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


// --- ROUTE 4: CHAN_DONGLE STATUS VIEW ---
app.get('/dongles', (req, res) => {
    try {
        refreshDongleStatus();
        res.render('dongles', { dongles: dongleStatus, moment });
    } catch (error) { res.status(500).send("Dongle Monitor Error: " + error.message); }
});

// --- ROUTE 5: DOWNLOAD PIPELINE ---
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
