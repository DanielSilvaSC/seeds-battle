/* Backup do Firestore do Seeds Battle → backups/AAAA-MM-DD.json
   Roda na GitHub Action semanal (ver .github/workflows/firestore-backup.yml).
   Sem dependências: autentica com a service account (JWT RS256) e usa a API REST.
   Sem FIREBASE_SERVICE_ACCOUNT no ambiente, roda anônimo — só os docs públicos
   (app/questions falha), útil para testar localmente. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT = 'seeds-battle';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const OUT_DIR = path.join(__dirname, '..', 'backups');
const KEEP = 12; // mantém as últimas 12 semanas

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const sig = crypto.createSign('RSA-SHA256').update(header + '.' + claims).sign(sa.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' + header + '.' + claims + '.' + b64url(sig)
  });
  if (!res.ok) throw new Error('token: HTTP ' + res.status + ' ' + await res.text());
  return (await res.json()).access_token;
}

/* Formato REST do Firestore → JSON puro */
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  throw new Error('tipo de valor não suportado: ' + JSON.stringify(v));
}
const fromFields = fields =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]));

async function listCollection(name, token) {
  const docs = {};
  let pageToken = '';
  do {
    const url = `${BASE}/${name}?pageSize=300` + (pageToken ? `&pageToken=${pageToken}` : '');
    const res = await fetch(url, token ? { headers: { Authorization: 'Bearer ' + token } } : {});
    if (!res.ok) throw new Error(name + ': HTTP ' + res.status + ' ' + await res.text());
    const data = await res.json();
    for (const d of data.documents || []) docs[d.name.split('/').pop()] = fromFields(d.fields || {});
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return docs;
}

/* Busca um doc; null se não existe. Sem token, um doc protegido (403) vira null
   com aviso — listar a coleção app inteira falharia por causa de app/questions. */
async function getDoc(docPath, token) {
  const res = await fetch(`${BASE}/${docPath}`, token ? { headers: { Authorization: 'Bearer ' + token } } : {});
  if (res.status === 404) return null;
  if (res.status === 403 && !token) { console.warn(docPath + ': protegido, pulado no modo anônimo'); return null; }
  if (!res.ok) throw new Error(docPath + ': HTTP ' + res.status + ' ' + await res.text());
  return fromFields((await res.json()).fields || {});
}

(async () => {
  let token = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    token = await getToken(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT ausente — backup anônimo (docs públicos apenas)');
  }
  const app = {};
  for (const d of ['config', 'hall', 'questions']) {
    const v = await getDoc('app/' + d, token);
    if (v) app[d] = v;
  }
  const backup = {
    exportedAt: new Date().toISOString(),
    project: PROJECT,
    app,
    entries: await listCollection('entries', token)
  };
  const nEntries = Object.values(backup.entries).reduce((s, m) => s + Object.keys(m).length, 0);
  if (!backup.app.config || !nEntries) throw new Error('backup suspeito de vazio — abortando para não gravar lixo');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, backup.exportedAt.slice(0, 10) + '.json');
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log('backup: ' + file + ' (' + nEntries + ' lançamentos, ' +
    Object.keys(backup.app).length + ' docs em app/)');

  // retenção: apaga os mais antigos além de KEEP
  const old = fs.readdirSync(OUT_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) {
    fs.unlinkSync(path.join(OUT_DIR, f));
    console.log('retenção: removido ' + f);
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
