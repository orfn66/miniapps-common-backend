import { createSign } from 'node:crypto';
import webpush from 'web-push';

const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
let cachedGoogleToken;

function serviceAccount() {
  try {
    const value = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON || 'null');
    if (!value?.client_email || !value?.private_key || !value?.project_id) throw new Error();
    return value;
  } catch { throw new Error('fcm_not_configured'); }
}
async function googleAccessToken(fetchImpl) {
  if (cachedGoogleToken?.expiresAt > Date.now() + 60_000) return cachedGoogleToken.value;
  const account = serviceAccount(), now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const signer = createSign('RSA-SHA256'); signer.update(unsigned); signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw Object.assign(new Error('fcm_auth_failed'), { permanent: response.status === 400 || response.status === 401 });
  const body = await response.json(); cachedGoogleToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 }; return body.access_token;
}

export async function deliverFcm(capability, payload, fetchImpl = fetch) {
  const account = serviceAccount(), accessToken = await googleAccessToken(fetchImpl);
  const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: { token: capability, notification: { title: payload.title, body: payload.body }, data: { ...payload.data, ...(payload.deep_link ? { deep_link: payload.deep_link } : {}) } } }), signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (response.ok) return { providerMessageId: String(body.name || '').slice(0, 256) };
  const code = String(body?.error?.details?.[0]?.errorCode || body?.error?.status || `http_${response.status}`).slice(0, 80);
  const permanent = response.status === 404 || response.status === 400 && ['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH'].includes(code);
  throw Object.assign(new Error(code), { code, permanent });
}

export async function deliverWebPush(capability, payload) {
  const subject = process.env.VAPID_SUBJECT || process.env.MEMA_VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY || process.env.MEMA_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY || process.env.MEMA_VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) throw new Error('web_push_not_configured');
  webpush.setVapidDetails(subject, publicKey, privateKey);
  try {
    const response = await webpush.sendNotification(capability, JSON.stringify(payload), { TTL: 3600 });
    return { providerMessageId: String(response.headers?.location || '').slice(0, 256) };
  } catch (error) {
    const code = `web_push_${error.statusCode || 'error'}`;
    throw Object.assign(new Error(code), { code, permanent: [404, 410].includes(error.statusCode) });
  }
}

export const transports = { fcm: deliverFcm, web_push: deliverWebPush };
