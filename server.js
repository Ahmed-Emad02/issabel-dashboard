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

// --- FIXED ASTERISK AMI REAL-TIME MONITORING ---
function connectAMI() {
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

            // Target channel creation and state updates
            if (event.Event === 'Newchannel' || event.Event === 'Newstate') {
                let exten = event.CallerIDNum;
                let connectedLine = event.ConnectedLineNum || '';
                
                if (exten && exten.length <= 5) {
                    let calculatedState = 'Ringing';
                    if (event.ChannelStateDesc === 'Up' || event.ChannelState === '6') {
                        calculatedState = 'In Call';
                    } else if (activeCalls[exten]?.state === 'In Call') {
                        calculatedState = 'In Call';
                    }

                    // TIMING FIX: Capture start time if it doesn't exist yet for this call sequence
                    activeCalls[exten] = {
                        state: calculatedState,
                        partner: connectedLine && connectedLine !== '<unknown>' ? connectedLine : (activeCalls[exten]?.partner || 'Connecting...'),
                        start: activeCalls[exten]?.start || Date.now()
                    };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Fallback catching: Ensure bridge entrances catch linked channel audio paths
            if (event.Event === 'BridgeEnter') {
                let exten = event.CallerIDNum;
                if (exten && activeCalls[exten]) {
                    activeCalls[exten].state = 'In Call';
                    activeCalls[exten].start = activeCalls[exten].start || Date.now();
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

io.on('connection', (socket) => {
    socket.emit('initialState', activeCalls);
});

// System Shared Middleware to fetch extension rosters and handle language toggles
app.use(async (req, res, next) => {
    try {
        const [roster] = await pool.query("SELECT extension, name FROM asterisk.users ORDER BY extension ASC");
        res.locals.roster = roster;
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
