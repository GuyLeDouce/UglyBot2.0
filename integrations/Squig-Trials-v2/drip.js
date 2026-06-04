import { CONFIG } from './config.js';

function authHeaders() {
  return {
    Authorization: `Bearer ${CONFIG.dripApiKey}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Award currency to a Discord ID via Credentials-Balances (no realm-member lookup).
 * This avoids the “not found in realm members” gotcha.
 *
 * DRIP docs: PATCH /realms/{realmId}/credentials/balance?type=discord-id&value=...
 */
export async function dripAwardByDiscordId({ discordUserId, amount }) {
  const url = new URL(`https://api.drip.re/api/v1/realms/${CONFIG.dripRealmId}/credentials/balance`);
  url.searchParams.set('type', CONFIG.dripCredentialType);
  url.searchParams.set('value', String(discordUserId));

  const body = {
    amount: Number(amount),
    realmPointId: CONFIG.dripCurrencyId
  };

  const r = await fetch(url.toString(), {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`DRIP award failed (${r.status}): ${text}`);
  }

  return await r.json();
}

/**
 * Find a realm member by Discord ID (returns member or null).
 * DRIP docs example: /realm/{realmId}/members/search?type=discord-id&values=...
 */
export async function dripFindMemberByDiscordId(discordUserId) {
  const url = new URL(`https://api.drip.re/api/v1/realms/${CONFIG.dripRealmId}/members/search`);
  url.searchParams.set('type', CONFIG.dripCredentialType);
  url.searchParams.set('values', String(discordUserId));

  const r = await fetch(url.toString(), { headers: authHeaders() });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`DRIP member search failed (${r.status}): ${text}`);
  }

  const data = await r.json();
  return data?.data?.[0] || null;
}
