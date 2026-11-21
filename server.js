const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { RouterOSAPI } = require('node-routeros');

const app = express();
app.use(cors());
app.use(express.json());

// Tangkap error tak tertangani agar Vercel tidak mati dengan FUNCTION_INVOCATION_FAILED
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, 'publik');

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

function parseComment(comment) {
  if (!comment || typeof comment !== 'string' || !comment.startsWith('BILLING:')) return {};
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
  const p = String(profileName || '').toLowerCase();
  const cfg = String(configuredIsolir || 'profile-isolir').toLowerCase();
  return p === cfg || p.includes('isolir');
}

function detectIsolirFromList(profileNames, configuredIsolir) {
  const cfg = String(configuredIsolir || 'profile-isolir').trim();
  if (profileNames.includes(cfg)) return cfg;
  const found = profileNames.find(n => String(n).toLowerCase().includes('isolir'));
  return found || cfg;
}

function getMikrotikConfig(req) {
  return {
    host: String(req.headers['x-mt-host'] || '').trim(),
    port: Number(req.headers['x-mt-port']) || 8728,
    user: String(req.headers['x-mt-user'] || '').trim(),
    password: String(req.headers['x-mt-pass'] || ''),
    isolirProfile: String(req.headers['x-mt-isolir'] || 'profile-isolir').trim(),
    fonnteToken: String(req.headers['x-wa-token'] || '').trim()
  };
}

function closeConnSafely(conn) {
  if (!conn) return;
  try {
    conn.removeAllListeners();
  } catch (_) {}
  try {
    if (conn.socket && typeof conn.socket.destroy === 'function') {
      conn.socket.destroy();
    }
  } catch (_) {}
  try {
    if (typeof conn.close === 'function') {
      conn.close();
    }
  } catch (_) {}
}

async function withMikrotik(req, callback) {
  const cfg = getMikrotikConfig(req);
  if (!cfg.host || !cfg.user) {
    throw new Error('Data login MikroTik belum diisi.');
  }

  const conn = new RouterOSAPI({
    host: cfg.host,
    user: cfg.user,
    password: cfg.password,
    port: cfg.port,
    timeout: 6,
    keepalive: false
  });

  conn.on('error', () => {});

  try {
    await conn.connect();
    return await callback(conn, cfg);
  } finally {
    closeConnSafely(conn);
  }
}

async function postFonnte(token, phone, message) {
  if (!token || !phone) {
    return { sent: false, reason: 'Token Fonnte atau nomor WA kosong' };
  }
  const fetchFn = typeof fetch === 'function' ? fetch : null;
  if (!fetchFn) {
    return { sent: false, reason: 'Fetch tidak tersedia di runtime Node' };
  }
  try {
    const res = await fetchFn('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ target: phone, message })
    });
    const data = await res.json();
    return { sent: Boolean(data && data.status), reason: (data && data.reason) || '' };
  } catch (err) {
    return { sent: false, reason: err && err.message ? err.message : 'Gagal hubungi Fonnte' };
  }
}

async function kickActiveUser(conn, username, cachedActives = null) {
  const actives = Array.isArray(cachedActives) ? cachedActives : await conn.write('/ppp/active/print');
  const target = String(username || '').trim().toLowerCase();
  for (const active of actives) {
    if (active && String(active.name || '').trim().toLowerCase() === target && active['.id']) {
      await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
    }
  }
}

app.get('/', (req, res) => {
  const candidates = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'publik', 'index.html'),
    path.join(__dirname, 'index.html')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return res.sendFile(p);
    }
  }
  res.status(200).send('MikroTik PPPoE Billing API aktif.');
});

app.post('/api/login', async (req, res) => {
  try {
    const detectedIsolir = await withMikrotik(req, async (conn, cfg) => {
      await conn.write('/system/identity/print');
      let profileNames = [];
      try {
        const list = await conn.write('/ppp/profile/print');
        if (Array.isArray(list)) {
          profileNames = list.map(p => p && p.name).filter(Boolean);
        }
      } catch (_) {}
      return detectIsolirFromList(profileNames, cfg.isolirProfile);
    });
    return res.json({ success: true, isolirProfile: detectedIsolir, message: 'Berhasil terhubung ke MikroTik!' });
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Gagal login MikroTik: ' + (err && err.message ? err.message : 'Koneksi ditolak')
    });
  }
});

app.get('/api/profiles', async (req, res) => {
  try {
    const profiles = await withMikrotik(req, async (conn) => {
      const list = await conn.write('/ppp/profile/print');
      return Array.isArray(list) ? list.map(p => p && p.name).filter(Boolean) : [];
    });
    return res.json({ success: true, data: profiles });
  } catch (err) {
    return res.status(500).json({ success: false, message: (err && err.message) || 'Gagal mengambil profile' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print');
      const actives = await conn.write('/ppp/active/print');
      let profileNames = [];
      try {
        const pList = await conn.write('/ppp/profile/print');
        if (Array.isArray(pList)) {
          profileNames = pList.map(p => p && p.name).filter(Boolean);
        }
      } catch (_) {}

      const actualIsolir = detectIsolirFromList(profileNames, cfg.isolirProfile);
      const activeMap = new Map();
      if (Array.isArray(actives)) {
        for (const a of actives) {
          const key = String((a && a.name) || '').trim().toLowerCase();
          if (key) activeMap.set(key, a);
        }
      }

      const list = Array.isArray(secrets) ? secrets : [];
      return list.map(secret => {
        const saved = parseComment(secret && secret.comment);
        const key = String((secret && secret.name) || '').trim().toLowerCase();
        const activeSession = activeMap.get(key);
        const online = Boolean(activeSession);
        const isolated = isIsolirName(secret && secret.profile, actualIsolir) || (secret && secret.disabled === 'true');

        return {
          id: secret['.id'],
          name: secret.name,
          profile: secret.profile || 'default',
          originalProfile: saved.op || (!isolated ? (secret.profile || 'default') : 'default'),
          online,
          uptime: activeSession ? (activeSession.uptime || '') : '',
          isIsolated: isolated,
          price: saved.p || 150000,
          phone: saved.wa || '',
          dueDate: saved.d || 10,
          status: saved.s || 'BELUM BAYAR',
          lastPaid: saved.lp || '',
          errorNote: saved.e || '',
          autoError: !online && !isolated ? 'Offline / Modem Mati / LOS' : ''
        };
      });
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: (err && err.message) || 'Gagal memuat user' });
  }
});

app.post('/api/users/update', async (req, res) => {
  const { id, name, profile, price, phone, dueDate, status, lastPaid } = req.body || {};
  try {
    await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print');
      const list = Array.isArray(secrets) ? secrets : [];
      const current = list.find(s => s && (s['.id'] === id || s.name === name)) || {};
      const targetId = current['.id'] || id;
      const oldData = parseComment(current.comment);

      const newStatus = status || oldData.s || 'BELUM BAYAR';
      const todayISO = new Date().toISOString().split('T')[0];
      const newLastPaid = newStatus === 'LUNAS'
        ? (lastPaid || oldData.lp || todayISO)
        : (lastPaid !== undefined ? lastPaid : (oldData.lp || ''));
      const targetProf = profile || current.profile || 'default';
      const origProfile = !isIsolirName(targetProf, cfg.isolirProfile)
        ? targetProf
        : (oldData.op || (!isIsolirName(current.profile, cfg.isolirProfile) ? current.profile : 'default'));

      const commentStr = buildComment({
        price,
        phone,
        dueDate,
        status: newStatus,
        lastPaid: newLastPaid,
        originalProfile: origProfile,
        errorNote: oldData.e || ''
      });

      const params = [`=.id=${targetId}`, `=comment=${commentStr}`];
      if (profile) params.push(`=profile=${profile}`);

      await conn.write('/ppp/secret/set', params);

      if (profile && profile !== current.profile) {
        await kickActiveUser(conn, name || current.name);
      }
    });
    return res.json({ success: true, message: `Data ${name || ''} tersimpan permanen di MikroTik.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal menyimpan: ' + ((err && err.message) || 'Error RouterOS') });
  }
});

app.post('/api/wa/send', async (req, res) => {
  const cfg = getMikrotikConfig(req);
  const { targets } = req.body || {};
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
    const r = await postFonnte(cfg.fonnteToken, t.phone, t.message);
    if (r.sent) sentCount++;
    else {
      failCount++;
      lastReason = r.reason || 'Unknown error';
    }
  }

  const detail = failCount > 0 ? ` Alasan: ${lastReason}` : '';
  return res.json({
    success: sentCount > 0,
    sentCount,
    failCount,
    message: `Selesai: ${sentCount} terkirim, ${failCount} gagal.${detail}`
  });
});

app.post('/api/billing/pay', async (req, res) => {
  const { id, name } = req.body || {};
  try {
    const todayISO = new Date().toISOString().split('T')[0];
    let savedData = {};

    await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print');
      const list = Array.isArray(secrets) ? secrets : [];
      const current = list.find(s => s && (s['.id'] === id || s.name === name)) || {};
      const targetId = current['.id'] || id;
      const targetName = current.name || name;
      const oldData = parseComment(current.comment);

      const targetProfile = oldData.op && !isIsolirName(oldData.op, cfg.isolirProfile)
        ? oldData.op
        : (!isIsolirName(current.profile, cfg.isolirProfile) ? (current.profile || 'default') : 'default');

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
        `=.id=${targetId}`,
        `=profile=${targetProfile}`,
        '=disabled=no',
        `=comment=${buildComment(savedData)}`
      ]);

      await kickActiveUser(conn, targetName);
    });

    const cfg = getMikrotikConfig(req);
    const harga = Number(savedData.price).toLocaleString('id-ID');
    const waMsg = `*PEMBAYARAN BERHASIL*\n\nHalo *${name}*,\nPembayaran internet sebesar Rp ${harga} pada tanggal ${todayISO} telah diterima (*LUNAS*). Layanan aktif kembali.`;
    const waResult = await postFonnte(cfg.fonnteToken, savedData.phone, waMsg);

    return res.json({ success: true, message: `User ${name} LUNAS & Isolir OFF. ${waResult.sent ? 'WA terkirim!' : ''}` });
  } catch (err) {
    return res.status(500).json({ success: false, message: (err && err.message) || 'Gagal memproses pembayaran' });
  }
});

app.post('/api/billing/isolate', async (req, res) => {
  const { id, name, currentProfile } = req.body || {};
  try {
    let savedData = {};
    let usedProfile = String(req.headers['x-mt-isolir'] || 'profile-isolir');

    await withMikrotik(req, async (conn, cfg) => {
      let profileNames = [];
      try {
        const pList = await conn.write('/ppp/profile/print');
        if (Array.isArray(pList)) {
          profileNames = pList.map(p => p && p.name).filter(Boolean);
        }
      } catch (_) {}

      const actualIsolir = detectIsolirFromList(profileNames, cfg.isolirProfile);
      usedProfile = actualIsolir;

      const secrets = await conn.write('/ppp/secret/print');
      const list = Array.isArray(secrets) ? secrets : [];
      const current = list.find(s => s && (s['.id'] === id || s.name === name)) || {};
      const targetId = current['.id'] || id;
      const targetName = current.name || name;
      const oldData = parseComment(current.comment);

      const origProfile = (currentProfile && !isIsolirName(currentProfile, actualIsolir))
        ? currentProfile
        : (!isIsolirName(current.profile, actualIsolir) ? (current.profile || 'default') : (oldData.op || 'default'));

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
        `=.id=${targetId}`,
        `=profile=${actualIsolir}`,
        `=comment=${buildComment(savedData)}`
      ]);

      await kickActiveUser(conn, targetName);
    });

    const cfg = getMikrotikConfig(req);
    const harga = Number(savedData.price).toLocaleString('id-ID');
    const waMsg = `*PEMBERITAHUAN ISOLIR*\n\nHalo *${name}*,\nLayanan internet Anda dinonaktifkan sementara karena melewati jatuh tempo. Tagihan: Rp ${harga}.`;
    const waResult = await postFonnte(cfg.fonnteToken, savedData.phone, waMsg);

    return res.json({ success: true, message: `Isolir ON untuk ${name} (Profile: ${usedProfile}). ${waResult.sent ? 'WA terkirim!' : ''}` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal isolir: ' + ((err && err.message) || 'Error RouterOS') });
  }
});

app.post('/api/billing/unisolate', async (req, res) => {
  const { id, name } = req.body || {};
  try {
    let restoredProfile = 'default';
    await withMikrotik(req, async (conn, cfg) => {
      let profileNames = [];
      try {
        const pList = await conn.write('/ppp/profile/print');
        if (Array.isArray(pList)) {
          profileNames = pList.map(p => p && p.name).filter(Boolean);
        }
      } catch (_) {}

      const actualIsolir = detectIsolirFromList(profileNames, cfg.isolirProfile);
      const secrets = await conn.write('/ppp/secret/print');
      const list = Array.isArray(secrets) ? secrets : [];
      const current = list.find(s => s && (s['.id'] === id || s.name === name)) || {};
      const targetId = current['.id'] || id;
      const targetName = current.name || name;
      const oldData = parseComment(current.comment);

      const fallbackProf = profileNames.find(n => !isIsolirName(n, actualIsolir) && n !== 'default-encryption') || 'default';

      restoredProfile = (oldData.op && !isIsolirName(oldData.op, actualIsolir))
        ? oldData.op
        : (!isIsolirName(current.profile, actualIsolir) ? (current.profile || fallbackProf) : fallbackProf);

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
        `=.id=${targetId}`,
        `=profile=${restoredProfile}`,
        '=disabled=no',
        `=comment=${buildComment(savedData)}`
      ]);

      await kickActiveUser(conn, targetName);
    });

    return res.json({ success: true, message: `Isolir OFF untuk ${name} (Kembali ke ${restoredProfile}).` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal buka isolir: ' + ((err && err.message) || 'Error RouterOS') });
  }
});

app.post('/api/billing/auto-isolate-unpaid', async (req, res) => {
  try {
    let count = 0;
    let usedProfile = String(req.headers['x-mt-isolir'] || 'profile-isolir');

    await withMikrotik(req, async (conn, cfg) => {
      let profileNames = [];
      try {
        const pList = await conn.write('/ppp/profile/print');
        if (Array.isArray(pList)) {
          profileNames = pList.map(p => p && p.name).filter(Boolean);
        }
      } catch (_) {}

      const actualIsolir = detectIsolirFromList(profileNames, cfg.isolirProfile);
      usedProfile = actualIsolir;

      const secrets = await conn.write('/ppp/secret/print');
      const actives = await conn.write('/ppp/active/print');
      const list = Array.isArray(secrets) ? secrets : [];

      for (const secret of list) {
        if (!secret || !secret['.id']) continue;
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

          await kickActiveUser(conn, secret.name, actives);
          count++;
        }
      }
    });
    return res.json({ success: true, message: `Berhasil mengisolir otomatis ${count} user belum bayar ke ${usedProfile}.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal isolir massal: ' + ((err && err.message) || 'Error RouterOS') });
  }
});

app.post('/api/billing/reset-month', async (req, res) => {
  try {
    await withMikrotik(req, async (conn, cfg) => {
      const secrets = await conn.write('/ppp/secret/print');
      const list = Array.isArray(secrets) ? secrets : [];
      for (const secret of list) {
        if (!secret || !secret['.id']) continue;
        const oldData = parseComment(secret.comment);
        if (oldData.s === 'LUNAS') {
          const updated = buildComment({
            price: oldData.p || 150000,
            phone: oldData.wa || '',
            dueDate: oldData.d || 10,
            status: 'BELUM BAYAR',
            lastPaid: oldData.lp || '',
            originalProfile: oldData.op || (!isIsolirName(secret.profile, cfg.isolirProfile) ? (secret.profile || 'default') : 'default'),
            errorNote: oldData.e || ''
          });
          await conn.write('/ppp/secret/set', [`=.id=${secret['.id']}`, `=comment=${updated}`]);
        }
      }
    });
    return res.json({ success: true, message: 'Semua status tagihan berhasil direset ke BELUM BAYAR.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: (err && err.message) || 'Gagal reset bulan' });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ success: false, message: (err && err.message) || 'Internal Server Error' });
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Aplikasi Billing berjalan di port ${PORT}`));
}

module.exports = app;
