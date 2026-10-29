const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Database = require('better-sqlite3');
const qrcode = require('qrcode-terminal');

const db = new Database('sales.db');
db.exec(`CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT DEFAULT (date('now')),
  amount REAL NOT NULL,
  item TEXT DEFAULT 'general'
)`);

const sales = {
  addSale: (amount, item) => {
    db.prepare('INSERT INTO sales (amount, item) VALUES (?, ?)').run(amount, item);
  },
  getToday: () => db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM sales WHERE date = date('now')").get().t,
  getWeek: () => db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM sales WHERE date >= date('now','-7 days')").get().t,
  getMonth: () => db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM sales WHERE date >= date('now','start of month')").get().t,
  getReport: () => {
    const t = db.prepare("SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as c FROM sales WHERE date = date('now')").get();
    const w = db.prepare("SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as c FROM sales WHERE date >= date('now','-7 days')").get();
    const m = db.prepare("SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as c FROM sales WHERE date >= date('now','start of month')").get();
    return `📊 Sales Report

📅 Today: ₹${t.total} (${t.c} sales)
📆 Week: ₹${w.total} (${w.c} sales)
📈 Month: ₹${m.total} (${m.c} sales)`;
  },
  getTopItems: () => {
    const items = db.prepare("SELECT item, SUM(amount) as total FROM sales WHERE date >= date('now','-7 days') GROUP BY item ORDER BY total DESC LIMIT 5").all();
    if (!items.length) return 'No sales this week';
    return '📋 Top Items (7 days)\n\n' + items.map((i, x) => `${x+1}. ${i.item}: ₹${i.total}`).join('\n');
  },
  deleteLast: () => {
    const last = db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 1').get();
    if (last) { db.prepare('DELETE FROM sales WHERE id = ?').run(last.id); return last; }
    return null;
  }
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: { level: 'silent' } });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Scan this QR with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      console.log('Reconnecting...');
      startBot();
    } else if (connection === 'open') {
      console.log('\n✅ Bot connected! Send "help"\n');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const cmd = body.toLowerCase().trim();

    try {
      if (cmd === 'help' || cmd === 'hi') {
        await sock.sendMessage(from, { text: `📊 Sales Bot Commands

📝 sale 500 - Record sale
📝 sale 500 rice - With item name

📈 report - Full summary
📅 today - Today only
📆 week - Last 7 days
📈 month - This month
📋 items - Top items
🗑️ delete - Remove last entry` });
      }
      else if (cmd.startsWith('sale ')) {
        const parts = body.split(' ');
        const amount = parseFloat(parts[1]);
        const item = parts.slice(2).join(' ') || 'general';
        if (isNaN(amount) || amount <= 0) {
          await sock.sendMessage(from, { text: '❌ Use: sale 500' });
          return;
        }
        sales.addSale(amount, item);
        await sock.sendMessage(from, { text: `✅ Recorded: ₹${amount} (${item})` });
      }
      else if (cmd === 'report') {
        await sock.sendMessage(from, { text: sales.getReport() });
      }
      else if (cmd === 'today') {
        await sock.sendMessage(from, { text: `📅 Today: ₹${sales.getToday()}` });
      }
      else if (cmd === 'week') {
        await sock.sendMessage(from, { text: `📆 Week: ₹${sales.getWeek()}` });
      }
      else if (cmd === 'month') {
        await sock.sendMessage(from, { text: `📈 Month: ₹${sales.getMonth()}` });
      }
      else if (cmd === 'items') {
        await sock.sendMessage(from, { text: sales.getTopItems() });
      }
      else if (cmd === 'delete') {
        const d = sales.deleteLast();
        await sock.sendMessage(from, { text: d ? `🗑️ Deleted: ₹${d.amount} (${d.item})` : 'Nothing to delete' });
      }
    } catch (e) {
      console.error('Error:', e);
    }
  });
}

startBot();
