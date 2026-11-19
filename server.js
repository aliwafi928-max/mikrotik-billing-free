const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { RouterOSAPI } = require('node-routeros');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'publik')));

const DB_FILE = path.join('/tmp', 'billing_data.json');

function readDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function getMikrotikConfig(req) {
  return {
    host: req.headers['x-mt-host'],
    port: Number(req.headers['x-mt-port']) || 8728,
    user: req.headers['x-mt-user'],
    password: req.headers['x-mt-pass'] || '',
    isolirProfile: req.headers['x-mt-isolir'] || 'isolir',
    fonnteToken: req.headers['x-wa-token'] || ''
  };
}

async function withMikrotik(req, callback) {
  const cfg = getMikrotikConfig(req);
  if (!cfg.host || !cfg.user) throw new Error('Data login MikroTik belum diisi.');
  const conn = new RouterOSAPI({
    host: cfg.host,
    user: cfg.user,
    password: cfg.password,
    port: cfg.port,
    timeout: 10
  });
  conn.on('error', () => {});
  try {
    await conn.connect();
    return await callback(conn, cfg);
  } finally {
    try { conn.close(); } catch (_) {}
  }
}

async function sendAutoWA(token, phone, message) {
  if (!token || !phone) return { sent: false, reason: 'Token Fonnte atau nomor WA kosong' };
  try {
    const res = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: phone, message })
    });
    const data = await res.json();
    return { sent: data.status === true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

app.post('/api/login', async (req, res) => {
  try {
    await withMikrotik(req, async (conn) => {
      await conn.write('/system/identity/print');
    });
    res.json({ success: true, message: 'Berhasil terhubung ke MikroTik!' });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Gagal login MikroTik: ' + (err.message || err.errno || 'Koneksi ditolak') });
  }
});

// Ambil daftar PPP Profile dari MikroTik
app.get('/api/profiles', async (req, res) => {
  try {
    const profiles = await withMikrotik(req, async (conn) => {
      const list = await conn.write('/ppp/profile/print');
      return list.map(p => p.name);
    });
    res.json({ success: true, data: profiles });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const cfg = getMikrotikConfig(req);
    const allDB = readDB();
    const db = allDB[cfg.host] || {};

    const result = await withMikrotik(req, async (conn) => {
      const secrets = await conn.write('/ppp/secret/print');
      const actives = await conn.write('/ppp/active/print');
      const activeNames = new Set(actives.map(a => a.name));

      return secrets.map(secret => {
        const saved = db[secret.name] || {};
        return {
          id: secret['.id'],
          name: secret.name,
          profile: secret.profile,
          originalProfile: saved.originalProfile || (secret.profile !== cfg.isolirProfile ? secret.profile : 'default'),
          online: activeNames.has(secret.name),
          isIsolated: secret.profile === cfg.isolirProfile || secret.disabled === 'true',
          price: saved.price || 150000,
          phone: saved.phone || '',
          dueDate: saved.dueDate || 10,
          status: saved.status || 'BELUM BAYAR',
          lastPaid: saved.lastPaid || ''
        };
      });
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update data user + Edit Profile langsung ke MikroTik
app.post('/api/users/update', async (req, res) => {
  const cfg = getMikrotikConfig(req);
  const { id, name, profile, price, phone, dueDate, lastPaid } = req.body;
  try {
    if (id && profile) {
      await withMikrotik(req, async (conn) => {
        await conn.write('/ppp/secret/set', [`=.id=${id}`, `=profile=${profile}`]);
        // Putus sesi aktif agar profile/kecepatan baru langsung diterapkan
        const actives = await conn.write('/ppp/active/print', [`?name=${name}`]);
        for (const active of actives) {
          await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
        }
      });
    }

    const allDB = readDB();
    if (!allDB[cfg.host]) allDB[cfg.host] = {};

    allDB[cfg.host][name] = {
      ...(allDB[cfg.host][name] || {}),
      price: Number(price) || 0,
      phone: phone || '',
      dueDate: Math.min(28, Math.max(1, Number(dueDate) || 10)),
      lastPaid: lastPaid !== undefined ? lastPaid : (allDB[cfg.host][name]?.lastPaid || ''),
      originalProfile: (profile && profile !== cfg.isolirProfile) ? profile : (allDB[cfg.host][name]?.originalProfile || 'default')
    };
    writeDB(allDB);
    res.json({ success: true, message: `Data & profile ${name} berhasil diperbarui.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal update: ' + err.message });
  }
});

app.post('/api/billing/pay', async (req, res) => {
  const cfg = getMikrotikConfig(req);
  const { id, name } = req.body;
  try {
    const allDB = readDB();
    if (!allDB[cfg.host]) allDB[cfg.host] = {};
    const userRecord = allDB[cfg.host][name] || {};
    const targetProfile = userRecord.originalProfile || 'default';
    const todayISO = new Date().toISOString().split('T')[0];

    await withMikrotik(req, async (conn) => {
      await conn.write('/ppp/secret/set', [`=.id=${id}`, `=profile=${targetProfile}`, `=disabled=no`]);
      const actives = await conn.write('/ppp/active/print', [`?name=${name}`]);
      for (const active of actives) {
        await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
      }
    });

    allDB[cfg.host][name] = { ...userRecord, status: 'LUNAS', lastPaid: todayISO };
    writeDB(allDB);

    const harga = Number(userRecord.price || 150000).toLocaleString('id-ID');
    const waMsg = `*PEMBAYARAN BERHASIL*\n\nHalo *${name}*,\nPembayaran internet sebesar Rp ${harga} pada tanggal ${todayISO} telah diterima (*LUNAS*). Layanan aktif kembali.`;
    const waResult = await sendAutoWA(cfg.fonnteToken, userRecord.phone, waMsg);

    res.json({ success: true, message: `User ${name} LUNAS. ${waResult.sent ? 'WA terkirim!' : ''}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/billing/isolate', async (req, res) => {
  const cfg = getMikrotikConfig(req);
  const { id, name, currentProfile } = req.body;
  try {
    const allDB = readDB();
    if (!allDB[cfg.host]) allDB[cfg.host] = {};
    const userRecord = allDB[cfg.host][name] || {};
    if (currentProfile && currentProfile !== cfg.isolirProfile) {
      userRecord.originalProfile = currentProfile;
    }

    await withMikrotik(req, async (conn) => {
      await conn.write('/ppp/secret/set', [`=.id=${id}`, `=profile=${cfg.isolirProfile}`]);
      const actives = await conn.write('/ppp/active/print', [`?name=${name}`]);
      for (const active of actives) {
        await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
      }
    });

    allDB[cfg.host][name] = { ...userRecord, status: 'BELUM BAYAR' };
    writeDB(allDB);

    const harga = Number(userRecord.price || 150000).toLocaleString('id-ID');
    const waMsg = `*PEMBERITAHUAN ISOLIR*\n\nHalo *${name}*,\nLayanan internet Anda dinonaktifkan sementara karena melewati jatuh tempo. Tagihan: Rp ${harga}.`;
    const waResult = await sendAutoWA(cfg.fonnteToken, userRecord.phone, waMsg);

    res.json({ success: true, message: `User ${name} diisolir. ${waResult.sent ? 'WA terkirim!' : ''}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/billing/reset-month', (req, res) => {
  const cfg = getMikrotikConfig(req);
  const allDB = readDB();
  if (allDB[cfg.host]) {
    Object.keys(allDB[cfg.host]).forEach(key => { allDB[cfg.host][key].status = 'BELUM BAYAR'; });
    writeDB(allDB);
  }
  res.json({ success: true, message: 'Semua tagihan router ini direset ke BELUM BAYAR.' });
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Aplikasi Billing berjalan di port ${PORT}`));
}

module.exports = app;
