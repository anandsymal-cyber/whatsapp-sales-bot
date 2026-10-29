// WhatsApp Sales Bot - records sales and reports totals via WhatsApp.
const fs = require('fs');
const path = require('path');
const http = require('http');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

// ---------- Config (set these in Render > Environment) ----------
// ALLOWED_NUMBERS: comma separated, country code, no + (e.g. 919876543210)
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || '919876543210')
  .split(',').map(s => s.trim()).filter(Boolean);
// PAIRING_NUMBER: optional. If set, bot prints an 8-char pairing code in logs
// instead of a QR (easier on a phone: WhatsApp > Linked devices > Link with phone number).
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').trim();
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PORT = process.env.PORT || 3000;

const SALES_FILE = path.join(DATA_DIR, 'sales.json');
const AUTH_DIR = path.join(DATA_DIR, 'auth_info');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Tiny web server (Render needs an open port; also for UptimeRobot) ----------
// The page also shows the current pairing code so you don't need to dig in the logs.
let pairingCode = '';
let waStatus = 'starting...';
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const codeHtml = pairingCode && waStatus !== 'connected'
    ? '<h1 style="font-size:48px;letter-spacing:6px">' + pairingCode + '</h1><p>Enter this in WhatsApp > Linked devices > Link with phone number</p>'
    : '';
  res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;padding:30px">' +
    '<h2>WhatsApp sales bot</h2><p>Status: <b>' + waStatus + '</b></p>' + codeHtml + '</body></html>');
}).listen(PORT, () => console.log('HTTP server on port ' + PORT));

// ---------- Storage ----------
function loadSales() {
  try { return JSON.parse(fs.readFileSync(SALES_FILE, 'utf8')); } catch { return []; }
}
function saveSales(list) {
  fs.writeFileSync(SALES_FILE, JSON.stringify(list, null, 2));
}

// ---------- Helpers ----------
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
function dayKey(ts) { return new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10); }
function monthKey(ts) { return dayKey(ts).slice(0, 7); }
const rupees = n => '₹' + Number(n).toLocaleString('en-IN');
const sum = list => list.reduce((a, s) => a + s.amount, 0);

function summary() {
  const sales = loadSales();
  const now = Date.now();
  const today = sales.filter(s => dayKey(s.ts) === dayKey(now));
  const week = sales.filter(s => now - s.ts < 7 * 86400000);
  const month = sales.filter(s => monthKey(s.ts) === monthKey(now));
  return { today, week, month };
}

function topItems() {
  const { week } = summary();
  const map = {};
  for (const s of week) {
    const k = (s.item || 'general').toLowerCase();
    map[k] = (map[k] || 0) + s.amount;
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
}

const HELP = [
  '*Sales Bot Commands*',
  'sale 500 - record ₹500',
  'sale 500 rice - record with item',
  'report - today / week / month',
  'today - today total',
  'week - last 7 days',
  'month - this month',
  'items - top 5 items this week',
  'delete - remove last entry',
  'help - this list',
].join('\n');

function handle(text) {
  const t = text.trim().toLowerCase();
  const [cmd, ...rest] = t.split(/\s+/);

  if (cmd === 'sale') {
    const amount = parseFloat(rest[0]);
    if (!isFinite(amount) || amount <= 0) return 'Usage: sale 500 [item]';
    const item = rest.slice(1).join(' ') || 'general';
    const sales = loadSales();
    sales.push({ ts: Date.now(), amount, item });
    saveSales(sales);
    const { today } = summary();
    return `✅ Recorded ${rupees(amount)} (${item})\nToday: ${rupees(sum(today))}`;
  }
  if (cmd === 'today') return `Today: ${rupees(sum(summary().today))}`;
  if (cmd === 'week') return `Last 7 days: ${rupees(sum(summary().week))}`;
  if (cmd === 'month') return `This month: ${rupees(sum(summary().month))}`;
  if (cmd === 'report') {
    const { today, week, month } = summary();
    return `📊 *Report*\nToday: ${rupees(sum(today))} (${today.length} sales)\n` +
      `Week: ${rupees(sum(week))} (${week.length} sales)\n` +
      `Month: ${rupees(sum(month))} (${month.length} sales)`;
  }
  if (cmd === 'items') {
    const top = topItems();
    if (!top.length) return 'No sales in the last 7 days.';
    return '🏆 *Top items (7 days)*\n' + top.map(([k, v], i) => `${i + 1}. ${k} - ${rupees(v)}`).join('\n');
  }
  if (cmd === 'delete') {
    const sales = loadSales();
    if (!sales.length) return 'Nothing to delete.';
    const last = sales.pop();
    saveSales(sales);
    return `🗑 Deleted ${rupees(last.amount)} (${last.item})`;
  }
  if (cmd === 'help' || cmd === 'hi' || cmd === 'hello') return HELP;
  return 'Unknown command. Send *help* to see commands.';
}

// ---------- WhatsApp ----------
const sentIds = new Set();
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Sales Bot', 'Chrome', '1.0.0'],
  });

  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (connection) console.log('connection.update:', connection);
    // WhatsApp is ready for linking when it sends the 'qr' event.
    if (qr && PAIRING_NUMBER && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      sock.requestPairingCode(PAIRING_NUMBER)
        .then(code => { pairingCode = code; waStatus = 'waiting for pairing code'; console.log('PAIRING CODE: ' + code + '  (enter within 1 minute)'); })
        .catch(e => console.error('Pairing code failed:', e.message));
    } else if (qr && !PAIRING_NUMBER) {
      console.log('Scan this QR with WhatsApp > Linked devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') { waStatus = 'connected'; pairingCode = ''; console.log('✅ WhatsApp connected'); }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      waStatus = 'reconnecting (' + code + ')';
      console.log('Disconnect reason:', code, lastDisconnect?.error?.message);
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete auth_info and redeploy to link again.');
      } else {
        console.log('Connection closed (' + code + '), reconnecting in 5s...');
        try { sock.end(undefined); } catch {}
        setTimeout(start, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
        const number = jid.split('@')[0].split(':')[0];
        // Allow the linked account itself (messaging "yourself") or listed numbers.
        if (sentIds.has(m.key.id)) continue; // ignore the bot's own replies
        if (!ALLOWED_NUMBERS.includes(number)) continue;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
        if (!text) continue;
        const reply = handle(text);
        const sent = await sock.sendMessage(jid, { text: reply });
        if (sent?.key?.id) {
          sentIds.add(sent.key.id);
          if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value);
        }
      } catch (e) { console.error('Handler error', e); }
    }
  });
}

start().catch(e => { console.error('Fatal', e); process.exit(1); });
