const express = require('express');
const cors = require('cors');
const path = require('path');
const { RouterOSAPI } = require('node-routeros');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'publik')));

// Baca data billing & kendala yang tersimpan permanen di kolom comment MikroTik
function parseComment(comment) {
  if (!comment || !comment.startsWith('BILLING:')) return {};
  try {
    return JSON.parse(comment.slice(8));
  } catch {
    return {};
  }
}

function buildComment(data) {
  return 'BILLING:' + JSON.stringify({
    p: Number(data.price) || 150000,
    wa: data.phone || '',
    d: Math.min(28, Math.max(1, Number(data.dueDate) || 10)),
    s: data.status || 'BELUM BAYAR',
    lp: data.lastPaid || '',
    op: data.originalProfile || 'default',
    e: data.errorNote || ''
  });
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
    return { sent: data.status === true, reason: data.reason || '' };
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
    const result = await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print');
      const actives = await conn.write('/ppp/active/print');
      const activeNames = new Set(actives.map(a => a.name));

      return secrets.map(secret => {
        const saved = parseComment(secret.comment);
        return {
          id: secret['.id'],
          name: secret.name,
          profile: secret.profile,
          originalProfile: saved.op || (secret.profile !== cfg.isolirProfile ? secret.profile : 'default'),
          online: activeNames.has(secret.name),
          isIsolated: secret.profile === cfg.isolirProfile || secret.disabled === 'true',
          price: saved.p || 150000,
          phone: saved.wa || '',
          dueDate: saved.d || 10,
          status: saved.s || 'BELUM BAYAR',
          lastPaid: saved.lp || '',
          errorNote: saved.e || ''
        };
      });
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Edit Profile & Pembayaran (Tersimpan Permanen di MikroTik)
app.post('/api/users/update', async (req, res) => {
  const { id, name, profile, price, phone, dueDate, status, lastPaid } = req.body;
  try {
    await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);

      const newStatus = status || oldData.s || 'BELUM BAYAR';
      const todayISO = new Date().toISOString().split('T')[0];
      const newLastPaid = newStatus === 'LUNAS' ? (lastPaid || oldData.lp || todayISO) : (lastPaid !== undefined ? lastPaid : oldData.lp || '');
      const origProfile = (profile && profile !== cfg.isolirProfile) ? profile : (oldData.op || current.profile || 'default');

      const commentStr = buildComment({
        price,
        phone,
        dueDate,
        status: newStatus,
        lastPaid: newLastPaid,
        originalProfile: origProfile,
        errorNote: oldData.e || ''
      });

      const params = [`=.id=${id}`, `=comment=${commentStr}`];
      if (profile) params.push(`=profile=${profile}`);

      await conn.write('/ppp/secret/set', params);

      if (profile && profile !== current.profile) {
        const actives = await conn.write('/ppp/active/print', [`?name=${name}`]);
        for (const active of actives) {
          await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
        }
      }
    });
    res.json({ success: true, message: `Data & pembayaran ${name} tersimpan permanen di MikroTik.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal menyimpan: ' + err.message });
  }
});

// Simpan / Hapus Catatan Kendala / Eror User PPPoE
app.post('/api/users/error', async (req, res) => {
  const { id, name, errorNote } = req.body;
  try {
    await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);

      const commentStr = buildComment({
        price: oldData.p || 150000,
        phone: oldData.wa || '',
        dueDate: oldData.d || 10,
        status: oldData.s || 'BELUM BAYAR',
        lastPaid: oldData.lp || '',
        originalProfile: oldData.op || (current.profile !== cfg.isolirProfile ? current.profile : 'default'),
        errorNote: (errorNote || '').trim()
      });

      await conn.write('/ppp/secret/set', [`=.id=${id}`, `=comment=${commentStr}`]);
    });
    res.json({ success: true, message: errorNote ? `Kendala untuk ${name} berhasil dicatat.` : `Kendala ${name} ditandai selesai.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal menyimpan kendala: ' + err.message });
  }
});

// Kirim WA Otomatis (Satuan atau Massal ke Belum Bayar) via Fonnte
app.post('/api/wa/send', async (req, res) => {
  const cfg = getMikrotikConfig(req);
  const { targets } = req.body; // [{ phone, message, name }]
  if (!cfg.fonnteToken) {
    return res.status(400).json({ success: false, message: 'Token Fonnte belum diisi di pengaturan WA Otomatis.' });
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ success: false, message: 'Tidak ada target nomor WA yang valid.' });
  }

  let sentCount = 0;
  let failCount = 0;
  for (const t of targets) {
    const r = await sendAutoWA(cfg.fonnteToken, t.phone, t.message);
    if (r.sent) sentCount++;
    else failCount++;
  }
  res.json({ success: true, message: `Selesai: ${sentCount} pesan WA terkirim, ${failCount} gagal.` });
});

app.post('/api/billing/pay', async (req, res) => {
  const { id, name } = req.body;
  try {
    const todayISO = new Date().toISOString().split('T')[0];
    let savedData = {};

    await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);
      const targetProfile = oldData.op || (current.profile !== cfg.isolirProfile ? current.profile : 'default');

      savedData = {
        price: oldData.p || 150000,
        phone: oldData.wa || '',
        dueDate: oldData.d || 10,
        status: 'LUNAS',
        lastPaid: todayISO,
        originalProfile: targetProfile,
        errorNote: oldData.e || ''
      };

      await conn.write('/ppp/secret/set', [
        `=.id=${id}`,
        `=profile=${targetProfile}`,
        `=disabled=no`,
        `=comment=${buildComment(savedData)}`
      ]);

      const actives = await conn.write('/ppp/active/print', [`?name=${name}`]);
      for (const active of actives) {
        await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
      }
    });

    const cfg = getMikrotikConfig(req);
    const harga = Number(savedData.price).toLocaleString('id-ID');
    const waMsg = `*PEMBAYARAN BERHASIL*\n\nHalo *${name}*,\nPembayaran internet sebesar Rp ${harga} pada tanggal ${todayISO} telah diterima (*LUNAS*). Layanan aktif kembali.`;
    const waResult = await sendAutoWA(cfg.fonnteToken, savedData.phone, waMsg);

    res.json({ success: true, message: `User ${name} LUNAS & tersimpan permanen. ${waResult.sent ? 'WA terkirim!' : ''}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/billing/isolate', async (req, res) => {
  const { id, name, currentProfile } = req.body;
  try {
    let savedData = {};

    await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);
      const origProfile = (currentProfile && currentProfile !== cfg.isolirProfile) ? currentProfile : (oldData.op || 'default');

      savedData = {
        price: oldData.p || 150000,
        phone: oldData.wa || '',
        dueDate: oldData.d || 10,
        status: 'BELUM BAYAR',
        lastPaid: oldData.lp || '',
        originalProfile: origProfile,
        errorNote: oldData.e || ''
      };

      await conn.write('/ppp/secret/set', [
        `=.id=${id}`,
        `=profile=${cfg.isolirProfile}`,
        `=comment=${buildComment(savedData)}`
      ]);

      const actives = await conn.write('/ppp/active/print', [`?name=${name}`]);
      for (const active of actives) {
        await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
      }
    });

    const cfg = getMikrotikConfig(req);
    const harga = Number(savedData.price).toLocaleString('id-ID');
    const waMsg = `*PEMBERITAHUAN ISOLIR*\n\nHalo *${name}*,\nLayanan internet Anda dinonaktifkan sementara karena melewati jatuh tempo. Tagihan: Rp ${harga}.`;
    const waResult = await sendAutoWA(cfg.fonnteToken, savedData.phone, waMsg);

    res.json({ success: true, message: `User ${name} diisolir. ${waResult.sent ? 'WA terkirim!' : ''}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/billing/reset-month', async (req, res) => {
  try {
    await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print');
      for (const secret of secrets) {
        const oldData = parseComment(secret.comment);
        if (oldData.s === 'LUNAS') {
          const updated = buildComment({
            price: oldData.p || 150000,
            phone: oldData.wa || '',
            dueDate: oldData.d || 10,
            status: 'BELUM BAYAR',
            lastPaid: oldData.lp || '',
            originalProfile: oldData.op || (secret.profile !== cfg.isolirProfile ? secret.profile : 'default'),
            errorNote: oldData.e || ''
          });
          await conn.write('/ppp/secret/set', [`=.id=${secret['.id']}`, `=comment=${updated}`]);
        }
      }
    });
    res.json({ success: true, message: 'Semua status tagihan berhasil direset ke BELUM BAYAR.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Aplikasi Billing berjalan di port ${PORT}`));
}

module.exports = app;
