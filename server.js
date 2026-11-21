const express = require('express');
const cors = require('cors');
const path = require('path');
const { RouterOSAPI } = require('node-routeros');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'publik')));

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

function isIsolirName(profileName, configuredIsolir) {
  const p = (profileName || '').toLowerCase();
  const cfg = (configuredIsolir || 'isolir').toLowerCase();
  return p === cfg || p.includes('isolir');
}

async function resolveIsolirProfile(conn, configuredIsolir) {
  const profiles = await conn.write('/ppp/profile/print');
  const names = profiles.map(p => p.name);
  const cfg = (configuredIsolir || 'isolir').trim();
  if (names.includes(cfg)) return cfg;
  const found = names.find(n => n.toLowerCase().includes('isolir'));
  return found || cfg;
}

function detectAutoError(secret, isOnline, isolirProfile, logs) {
  if (secret.disabled === 'true') return 'Akun Dinonaktifkan (Disabled)';
  if (isIsolirName(secret.profile, isolirProfile)) return 'Terisolir (Profile Isolir)';

  const uname = (secret.name || '').trim().toLowerCase();
  let disconnectCount = 0;
  let lastLogReason = '';

  for (let i = logs.length - 1; i >= 0; i--) {
    const msg = (logs[i].message || '').toLowerCase();
    if (!msg.includes(uname)) continue;

    if (msg.includes('disconnected') || msg.includes('terminating')) disconnectCount++;
    if (lastLogReason) continue;

    if (msg.includes('authentication failed')) lastLogReason = 'Gagal Login (User/Password Salah)';
    else if (msg.includes('not responding')) lastLogReason = 'LOS / Kabel Putus / Modem Mati (Not Responding)';
    else if (msg.includes('duplicate') || msg.includes('already')) lastLogReason = 'Login Ganda (User Dipakai di 2 Modem)';
    else if (msg.includes('pool') || msg.includes('address')) lastLogReason = 'Gagal Dapat IP (IP Pool Penuh)';
    else if (msg.includes('lcp') || msg.includes('negotiation')) lastLogReason = 'Gagal Negosiasi PPPoE (Cek VLAN/ONT)';
    else if (msg.includes('session timeout') || msg.includes('idle timeout')) lastLogReason = 'Sesi Habis (Session/Idle Timeout)';
    else if (msg.includes('hungup')) lastLogReason = 'Modem Dimatikan / Restart Pelanggan (Hungup)';
    else if (msg.includes('disconnected') || msg.includes('terminating')) lastLogReason = 'Koneksi Terputus Tiba-Tiba (Cek Redaman/Kabel)';
  }

  if (isOnline) {
    if (disconnectCount >= 3) return `Sering Putus-Nyambung / Redaman Tinggi (${disconnectCount}x DC)`;
    return '';
  }

  if (lastLogReason) return lastLogReason;

  const lastOut = secret['last-logged-out'] && secret['last-logged-out'] !== 'jan/01/1970 00:00:00'
    ? ` (Sejak ${secret['last-logged-out']})`
    : '';
  return `Offline / Modem Mati / LOS${lastOut}`;
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
    timeout: 8
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

async function kickActiveUser(conn, username) {
  const actives = await conn.write('/ppp/active/print');
  const target = (username || '').trim().toLowerCase();
  for (const active of actives) {
    if ((active.name || '').trim().toLowerCase() === target) {
      await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
    }
  }
}

app.post('/api/login', async (req, res) => {
  try {
    const detectedIsolir = await withMikrotik(req, async (conn, cfg) => {
      await conn.write('/system/identity/print');
      return await resolveIsolirProfile(conn, cfg.isolirProfile);
    });
    res.json({ success: true, isolirProfile: detectedIsolir, message: 'Berhasil terhubung ke MikroTik!' });
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
      const actualIsolir = await resolveIsolirProfile(conn, cfg.isolirProfile);
      let logs = [];
      try {
        const rawLogs = await conn.write('/log/print', ['?topics=pppoe,ppp,info']);
        logs = rawLogs.slice(-150);
      } catch (_) {}

      const activeMap = new Map();
      for (const a of actives) {
        const key = (a.name || '').trim().toLowerCase();
        if (key) activeMap.set(key, a);
      }

      return secrets.map(secret => {
        const saved = parseComment(secret.comment);
        const key = (secret.name || '').trim().toLowerCase();
        const activeSession = activeMap.get(key);
        const online = Boolean(activeSession);
        const isolated = isIsolirName(secret.profile, actualIsolir) || secret.disabled === 'true';
        const autoError = detectAutoError(secret, online, actualIsolir, logs);

        return {
          id: secret['.id'],
          name: secret.name,
          profile: secret.profile,
          originalProfile: saved.op || (!isolated ? secret.profile : 'default'),
          online,
          uptime: activeSession ? (activeSession.uptime || '') : '',
          isIsolated: isolated,
          price: saved.p || 150000,
          phone: saved.wa || '',
          dueDate: saved.d || 10,
          status: saved.s || 'BELUM BAYAR',
          lastPaid: saved.lp || '',
          errorNote: saved.e || '',
          autoError
        };
      });
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/users/update', async (req, res) => {
  const { id, name, profile, price, phone, dueDate, status, lastPaid } = req.body;
  try {
    await withMikrotik(req, async (conn, cfg) => {
      const actualIsolir = await resolveIsolirProfile(conn, cfg.isolirProfile);
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);

      const newStatus = status || oldData.s || 'BELUM BAYAR';
      const todayISO = new Date().toISOString().split('T')[0];
      const newLastPaid = newStatus === 'LUNAS' ? (lastPaid || oldData.lp || todayISO) : (lastPaid !== undefined ? lastPaid : oldData.lp || '');
      const targetProf = profile || current.profile;
      const origProfile = !isIsolirName(targetProf, actualIsolir) ? targetProf : (oldData.op || (!isIsolirName(current.profile, actualIsolir) ? current.profile : 'default'));

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
        await kickActiveUser(conn, name);
      }
    });
    res.json({ success: true, message: `Data ${name} tersimpan permanen di MikroTik.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal menyimpan: ' + err.message });
  }
});

app.post('/api/users/error', async (req, res) => {
  const { id, name, errorNote } = req.body;
  try {
    await withMikrotik(req, async (conn, cfg) => {
      const actualIsolir = await resolveIsolirProfile(conn, cfg.isolirProfile);
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);

      const commentStr = buildComment({
        price: oldData.p || 150000,
        phone: oldData.wa || '',
        dueDate: oldData.d || 10,
        status: oldData.s || 'BELUM BAYAR',
        lastPaid: oldData.lp || '',
        originalProfile: oldData.op || (!isIsolirName(current.profile, actualIsolir) ? current.profile : 'default'),
        errorNote: (errorNote || '').trim()
      });

      await conn.write('/ppp/secret/set', [`=.id=${id}`, `=comment=${commentStr}`]);
    });
    res.json({ success: true, message: errorNote ? `Kendala ${name} disimpan.` : `Kendala ${name} dihapus.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal menyimpan kendala: ' + err.message });
  }
});

app.post('/api/wa/send', async (req, res) => {
  const cfg = getMikrotikConfig(req);
  const { targets } = req.body;
  if (!cfg.fonnteToken) {
    return res.status(400).json({ success: false, message: 'Token Fonnte belum diisi.' });
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ success: false, message: 'Tidak ada target nomor WA yang valid.' });
  }

  let sentCount = 0;
  let failCount = 0;
  let lastReason = '';
  for (const t of targets) {
    const r = await sendAutoWA(cfg.fonnteToken, t.phone, t.message);
    if (r.sent) sentCount++;
    else {
      failCount++;
      lastReason = r.reason || 'Unknown error';
    }
  }
  const detail = failCount > 0 ? ` Alasan: ${lastReason}` : '';
  res.json({ success: true, message: `Selesai: ${sentCount} terkirim, ${failCount} gagal.${detail}` });
});

app.post('/api/billing/pay', async (req, res) => {
  const { id, name } = req.body;
  try {
    const todayISO = new Date().toISOString().split('T')[0];
    let savedData = {};

    await withMikrotik(req, async (conn, cfg) => {
      const actualIsolir = await resolveIsolirProfile(conn, cfg.isolirProfile);
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);
      const targetProfile = oldData.op && !isIsolirName(oldData.op, actualIsolir)
        ? oldData.op
        : (!isIsolirName(current.profile, actualIsolir) ? current.profile : 'default');

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

      await kickActiveUser(conn, name);
    });

    const cfg = getMikrotikConfig(req);
    const harga = Number(savedData.price).toLocaleString('id-ID');
    const waMsg = `*PEMBAYARAN BERHASIL*\n\nHalo *${name}*,\nPembayaran internet sebesar Rp ${harga} pada tanggal ${todayISO} telah diterima (*LUNAS*). Layanan aktif kembali.`;
    const waResult = await sendAutoWA(cfg.fonnteToken, savedData.phone, waMsg);

    res.json({ success: true, message: `User ${name} LUNAS & Isolir OFF. ${waResult.sent ? 'WA terkirim!' : ''}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ISOLIR ON (AKTIFKAN ISOLIR)
app.post('/api/billing/isolate', async (req, res) => {
  const { id, name, currentProfile } = req.body;
  try {
    let savedData = {};
    let usedProfile = '';

    await withMikrotik(req, async (conn, cfg) => {
      const actualIsolir = await resolveIsolirProfile(conn, cfg.isolirProfile);
      usedProfile = actualIsolir;
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);
      const origProfile = (currentProfile && !isIsolirName(currentProfile, actualIsolir))
        ? currentProfile
        : (!isIsolirName(current.profile, actualIsolir) ? current.profile : (oldData.op || 'default'));

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
        `=profile=${actualIsolir}`,
        `=comment=${buildComment(savedData)}`
      ]);

      await kickActiveUser(conn, name);
    });

    const cfg = getMikrotikConfig(req);
    const harga = Number(savedData.price).toLocaleString('id-ID');
    const waMsg = `*PEMBERITAHUAN ISOLIR*\n\nHalo *${name}*,\nLayanan internet Anda dinonaktifkan sementara karena melewati jatuh tempo. Tagihan: Rp ${harga}.`;
    const waResult = await sendAutoWA(cfg.fonnteToken, savedData.phone, waMsg);

    res.json({ success: true, message: `Isolir ON untuk ${name} (Profile: ${usedProfile}). ${waResult.sent ? 'WA terkirim!' : ''}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal isolir: ' + err.message });
  }
});

// ISOLIR OFF (BUKA ISOLIR TANPA UBAH STATUS LUNAS)
app.post('/api/billing/unisolate', async (req, res) => {
  const { id, name } = req.body;
  try {
    let restoredProfile = 'default';
    await withMikrotik(req, async (conn, cfg) => {
      const actualIsolir = await resolveIsolirProfile(conn, cfg.isolirProfile);
      const secrets = await conn.write('/ppp/secret/print', [`?.id=${id}`]);
      const current = secrets[0] || {};
      const oldData = parseComment(current.comment);

      const profiles = await conn.write('/ppp/profile/print');
      const fallbackProf = profiles.map(p => p.name).find(n => !isIsolirName(n, actualIsolir) && n !== 'default-encryption') || 'default';

      restoredProfile = (oldData.op && !isIsolirName(oldData.op, actualIsolir))
        ? oldData.op
        : (!isIsolirName(current.profile, actualIsolir) ? current.profile : fallbackProf);

      const savedData = {
        price: oldData.p || 150000,
        phone: oldData.wa || '',
        dueDate: oldData.d || 10,
        status: oldData.s || 'BELUM BAYAR',
        lastPaid: oldData.lp || '',
        originalProfile: restoredProfile,
        errorNote: oldData.e || ''
      };

      await conn.write('/ppp/secret/set', [
        `=.id=${id}`,
        `=profile=${restoredProfile}`,
        `=disabled=no`,
        `=comment=${buildComment(savedData)}`
      ]);

      await kickActiveUser(conn, name);
    });

    res.json({ success: true, message: `Isolir OFF untuk ${name} (Kembali ke ${restoredProfile}).` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal buka isolir: ' + err.message });
  }
});

// ISOLIR OTOMATIS MASSAL (SEMUA BELUM BAYAR)
app.post('/api/billing/auto-isolate-unpaid', async (req, res) => {
  try {
    let count = 0;
    let usedProfile = '';
    await withMikrotik(req, async (conn, cfg) => {
      const actualIsolir = await resolveIsolirProfile(conn, cfg.isolirProfile);
      usedProfile = actualIsolir;
      const secrets = await conn.write('/ppp/secret/print');
      const actives = await conn.write('/ppp/active/print');

      for (const secret of secrets) {
        const oldData = parseComment(secret.comment);
        const status = oldData.s || 'BELUM BAYAR';
        const alreadyIsolir = isIsolirName(secret.profile, actualIsolir) || secret.disabled === 'true';

        if (status !== 'LUNAS' && !alreadyIsolir) {
          const updated = buildComment({
            price: oldData.p || 150000,
            phone: oldData.wa || '',
            dueDate: oldData.d || 10,
            status: 'BELUM BAYAR',
            lastPaid: oldData.lp || '',
            originalProfile: secret.profile || oldData.op || 'default',
            errorNote: oldData.e || ''
          });

          await conn.write('/ppp/secret/set', [
            `=.id=${secret['.id']}`,
            `=profile=${actualIsolir}`,
            `=comment=${updated}`
          ]);

          const target = (secret.name || '').trim().toLowerCase();
          for (const act of actives) {
            if ((act.name || '').trim().toLowerCase() === target) {
              await conn.write('/ppp/active/remove', [`=.id=${act['.id']}`]);
            }
          }
          count++;
        }
      }
    });
    res.json({ success: true, message: `Berhasil mengisolir otomatis ${count} user belum bayar ke ${usedProfile}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal isolir massal: ' + err.message });
  }
});

app.post('/api/billing/reset-month', async (req, res) => {
  try {
    await withMikrotik(req, async (conn, cfg) => {
      const actualIsolir = await resolveIsolirProfile(conn, cfg.isolirProfile);
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
            originalProfile: oldData.op || (!isIsolirName(secret.profile, actualIsolir) ? secret.profile : 'default'),
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
