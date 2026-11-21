const express = require('express');
const cors = require('cors');
const path = require('path');
const { RouterOSAPI } = require('node-routeros');

const app = express();
app.use(cors());
app.use(express.json());

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
  const cfg = (configuredIsolir || 'profile-isolir').toLowerCase();
  return p === cfg || p.includes('isolir');
}

function detectIsolirFromList(profileNames, configuredIsolir) {
  const cfg = (configuredIsolir || 'profile-isolir').trim();
  if (profileNames.includes(cfg)) return cfg;
  const found = profileNames.find(n => n.toLowerCase().includes('isolir'));
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
    if (disconnectCount >= 3) return `Sering Putus-Nyambung / Redaman Tinggi (${disconnectCount}x DC)`; return ''; }  if (lastLogReason) return lastLogReason;  const lastOut = secret['last-logged-out'] && secret['last-logged-out'] !== 'jan/01/1970 00:00:00' ? ` (Sejak ${secret['last-logged-out']})`
    : '';
  return `Offline / Modem Mati / LOS${lastOut}`; }  function getMikrotikConfig(req) { return { host: req.headers['x-mt-host'], port: Number(req.headers['x-mt-port']) \vert{}\vert{} 8728, user: req.headers['x-mt-user'], password: req.headers['x-mt-pass'] \vert{}\vert{} '', isolirProfile: req.headers['x-mt-isolir'] \vert{}\vert{} 'profile-isolir', fonnteToken: req.headers['x-wa-token'] \vert{}\vert{} '' }; }  async function withMikrotik(req, callback) { const cfg = getMikrotikConfig(req); if (!cfg.host \vert{}\vert{} !cfg.user) throw new Error('Data login MikroTik belum diisi.'); const conn = new RouterOSAPI({ host: cfg.host, user: cfg.user, password: cfg.password, port: cfg.port, timeout: 7 }); conn.on('error', () => {}); try { await conn.connect(); return await callback(conn, cfg); } finally { try { conn.close(); } catch (_) {} } }  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }  function randomDelayMs(minSec = 3, maxSec = 7) { const minMs = Math.max(0, Number(minSec) \vert{}\vert{} 0) * 1000; const maxMs = Math.max(minMs, (Number(maxSec) \vert{}\vert{} 0) * 1000); if (maxMs === 0) return 0; return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs; }  async function sendAutoWA(token, phone, message) { if (!token \vert{}\vert{} !phone) return { sent: false, reason: 'Token Fonnte atau nomor WA kosong' }; try { const res = await fetch('https://api.fonnte.com/send', { method: 'POST', headers: { 'Authorization': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ target: phone, message }) }); const data = await res.json(); return { sent: data.status === true, reason: data.reason \vert{}\vert{} '' }; } catch (err) { return { sent: false, reason: err.message }; } }  async function kickActiveUser(conn, username, cachedActives = null) { const actives = cachedActives \vert{}\vert{} await conn.write('/ppp/active/print'); const target = (username \vert{}\vert{} '').trim().toLowerCase(); for (const active of actives) { if ((active.name \vert{}\vert{} '').trim().toLowerCase() === target && active['.id']) { await conn.write('/ppp/active/remove', [`=.id=${active['.id']}`]);
    }
  }
}

const HTML_APP = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MikroTik PPPoE Billing</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" />
  <style>
    .sidebar-gradient {
      background: radial-gradient(circle at 25% 12%, #1346a8 0%, #092154 45%, #041130 100%);
    }
    .router-glow {
      background: radial-gradient(ellipse at center, rgba(37, 130, 255, 0.45) 0%, rgba(4, 17, 48, 0) 70%);
    }
    .card-blue { background: linear-gradient(135deg, #1d8cf8 0%, #0d6efd 100%); }
    .card-green { background: linear-gradient(135deg, #19b36b 0%, #0b8a4b 100%); }
    .card-orange { background: linear-gradient(135deg, #ffae19 0%, #f5820d 100%); }
    .card-purple { background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 9999px; }
  </style>
</head>
<body class="bg-[#eef3f9] text-slate-800 min-h-screen font-sans antialiased">

  <!-- HALAMAN LOGIN -->
  <div id="loginScreen" class="min-h-screen flex items-center justify-center p-4 sidebar-gradient">
    <div class="bg-white border border-slate-200 rounded-2xl p-7 w-full max-w-md shadow-2xl">
      <div class="flex flex-col items-center mb-5">
        <div class="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center text-2xl shadow-lg mb-3">
          <i class="fa-solid fa-wifi"></i>
        </div>
        <h1 class="text-2xl font-bold text-slate-900">MikroTik <span class="text-cyan-500">BILLING</span></h1>
        <p class="text-slate-500 text-xs mt-1">Masukkan data Router MikroTik Anda untuk masuk</p>
      </div>

      <div id="loginError" class="hidden bg-red-50 border border-red-300 text-red-700 text-xs rounded-lg p-3 mb-4"></div>

      <form id="loginForm" class="space-y-3.5">
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2">
            <label class="block text-xs font-medium text-slate-600 mb-1">IP / Domain MikroTik</label>
            <input id="mtHost" type="text" required placeholder="id-19.hostddns.us" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-blue-600" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Port API</label>
            <input id="mtPort" type="number" required value="8728" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-blue-600" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Username</label>
            <input id="mtUser" type="text" required class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-blue-600" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Password</label>
            <input id="mtPass" type="password" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-blue-600" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Profile Isolir</label>
            <input id="mtIsolir" type="text" value="profile-isolir" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-blue-600" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Token Fonnte (Opsional)</label>
            <input id="waToken" type="text" placeholder="Token WA Auto" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-blue-600" />
          </div>
        </div>

        <button id="loginBtn" type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg shadow transition">
          Hubungkan ke MikroTik
        </button>
      </form>
      <p class="text-[11px] text-slate-400 text-center mt-4">Data tagihan & isolir tersimpan permanen di Router MikroTik Anda.</p>
    </div>
  </div>

  <!-- DASHBOARD UTAMA -->
  <div id="dashboardScreen" class="hidden min-h-screen flex">
    <div id="sidebarBackdrop" onclick="toggleSidebar()" class="hidden fixed inset-0 bg-black/50 z-30 md:hidden"></div>

    <aside id="sidebar" class="fixed md:static inset-y-0 left-0 z-40 w-60 sidebar-gradient text-white flex flex-col justify-between shrink-0 transform -translate-x-full md:translate-x-0 transition-transform duration-200 shadow
