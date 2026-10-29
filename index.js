const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

// ============ PRIVATE - ONLY YOU CAN USE ============
const ALLOWED_NUMBERS = ['919876543210']; // ← CHANGE TO YOUR NUMBER

function isAllowed(from) {
  const number = from.split('@')[0];
  return ALLOWED_NUMBERS.includes(number);
}
// =====================================================

// ============ JSON DATABASE ============
const DB_FILE = 'sales.json';

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { sales: [] };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const sales = {
  addSale: (amount, item) => {
    const db = loadDB();
    db.sales.push({
      date: new Date().toISOString().split('T')[0],
      amount: amount,
      item: item
    });
    saveDB(db);
  },
  
  getToday: () => {
    const db = loadDB();
    const today = new Date().toISOString().split('T')[0];
    return db.sales
      .filter(s => s.date === today)
      .reduce((sum, s) => sum + s.amount, 0);
  },
  
  getWeek: () => {
    const db = loadDB();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return db.sales
      .filter(s => s.date >= weekAgo)
      .reduce((sum, s) => sum + s.amount, 0);
  },
  
  getMonth: () => {
    const db = loadDB();
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStr = monthStart.toISOString().split('T')[0];
    return db.sales
      .filter(s => s.date >= monthStr)
      .reduce((sum, s) => sum + s.amount, 0);
  },
  
  getReport: () => {
    const db = loadDB();
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStr = monthStart.toISOString().split('T')[0];
    
    const todaySales = db.sales.filter(s => s.date === today);
    const weekSales = db.sales.filter(s => s.date >= weekAgo);
    const monthSales = db.sales.filter(s => s.date >= monthStr);
    
    const todayTotal = todaySales.reduce((sum, s) => sum + s.amount, 0);
    const weekTotal = weekSales.reduce((sum, s) => sum + s.amount, 0);
    const monthTotal = monthSales.reduce((sum, s) => sum + s.amount, 0);
    
    return `📊 Sales Report

📅 Today: ₹${todayTotal} (${todaySales.length} sales)
📆 Week: ₹${weekTotal} (${weekSales.length} sales)
📈 Month: ₹${monthTotal} (${monthSales.length} sales)`;
  },
  
  getTopItems: () => {
    const db = loadDB();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const items = {};
    
    db.sales
      .filter(s => s.date >= weekAgo)
      .forEach(s => {
        items[s.item] = (items[s.item] || 0) + s.amount;
      });
    
    const sorted = Object.entries(items)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    if (!sorted.length) return 'No sales this week';
    
    return '📋 Top Items (7 days)\n\n' + 
      sorted.map(([item, total], i) => `${i+1}. ${item}: ₹${total}`).join('\n');
  },
  
  deleteLast: () => {
    const db = loadDB();
    if (db.sales.length > 0) {
      const last = db.sales.pop();
      saveDB(db);
      return last;
    }
    return null;
  }
};

// ============ WHATSAPP BOT ============
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
    
    // PRIVATE CHECK - Ignore strangers
    if (!isAllowed(from)) return;

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
