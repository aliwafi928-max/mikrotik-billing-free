function detectAutoError(secret, isOnline, isolirProfile, logs) {
  if (secret.disabled === 'true') return 'Akun Dinonaktifkan (Disabled)';
  if (secret.profile === isolirProfile) return 'Terisolir (Profile Isolir)';

  const uname = (secret.name || '').toLowerCase();
  let disconnectCount = 0;
  let lastLogReason = '';

  // Cek 200 log terakhir untuk mendeteksi kendala spesifik & sering putus-nyambung
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

  // Jika sedang Online tapi sering putus-nyambung di log (>= 3 kali)
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
