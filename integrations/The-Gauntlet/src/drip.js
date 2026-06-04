// src/drip.js
// DRIP reward helper for $CHARM payouts

const axios = require("axios");
const { Store } = require("./db");

const DRIP_API_KEY =
  process.env.DRIP_API_KEY ||
  process.env.DRIP_API_TOKEN ||
  process.env.DRIP_CLIENT_SECRET;
const DRIP_CLIENT_ID = process.env.DRIP_CLIENT_ID;
const DRIP_REALM_ID = process.env.DRIP_REALM_ID;
const DEFAULT_DRIP_MEMBER_SENDER_ID = "66d2d8b48ddf8cc315a86f57";
const DRIP_INITIATOR_ID =
  process.env.DRIP_INITIATOR_ID ||
  process.env.DRIP_TIPPER_ID ||
  DEFAULT_DRIP_MEMBER_SENDER_ID;
const DRIP_SENDER_ID =
  process.env.DRIP_SENDER_ID ||
  process.env.DRIP_TRANSFER_SENDER_ID ||
  process.env.DRIP_TIPPER_ID ||
  DEFAULT_DRIP_MEMBER_SENDER_ID;
const DRIP_ALLOW_PROJECT_PAYOUT_FALLBACK =
  (process.env.DRIP_ALLOW_PROJECT_PAYOUT_FALLBACK || "false").toLowerCase() ===
  "true";
const DRIP_LOG_CHANNEL_ID =
  process.env.DRIP_LOG_CHANNEL_ID || "1403005536982794371";
const DRIP_BASE_URL = process.env.DRIP_BASE_URL || "https://api.drip.re";
const DRIP_DEBUG = (process.env.DRIP_DEBUG || "false").toLowerCase() === "true";
const DRIP_REALM_POINT_ID = process.env.DRIP_REALM_POINT_ID;

let envLogged = false;
function logEnvOnce() {
  if (envLogged) return;
  envLogged = true;
  const hasKey = Boolean(process.env.DRIP_API_KEY);
  const hasToken = Boolean(process.env.DRIP_API_TOKEN);
  const hasClientSecret = Boolean(process.env.DRIP_CLIENT_SECRET);
  const hasClientId = Boolean(process.env.DRIP_CLIENT_ID);
  const hasInitiatorId = Boolean(
    process.env.DRIP_INITIATOR_ID || process.env.DRIP_TIPPER_ID
  );
  const hasSenderId = Boolean(
    process.env.DRIP_SENDER_ID || process.env.DRIP_TRANSFER_SENDER_ID
  );
  const hasRealm = Boolean(process.env.DRIP_REALM_ID);
  const hasBase = Boolean(process.env.DRIP_BASE_URL);
  console.log(
    `[GAUNTLET:DRIP] Env check: key=${hasKey} token=${hasToken} clientSecret=${hasClientSecret} clientId=${hasClientId} initiatorId=${hasInitiatorId} senderId=${hasSenderId} realm=${hasRealm} baseUrl=${hasBase}`
  );
}

function buildRealmBaseUrl() {
  const raw = DRIP_BASE_URL || "";
  const base = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const lower = base.toLowerCase();
  // Check "/realms" first so it doesn't get captured by "/realm" substring matching.
  if (lower.includes("/api/v1/realms")) {
    return base.replace(/\/api\/v1\/realms/i, "/api/v1/realm");
  }
  if (lower.includes("/api/v1/realm")) return base;
  if (lower.endsWith("/realms")) return `${base.slice(0, -"/realms".length)}/realm`;
  if (lower.endsWith("/realm")) return base;
  return `${base}/api/v1/realm`;
}

function buildRealmsBaseUrl() {
  const raw = DRIP_BASE_URL || "";
  const base = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const lower = base.toLowerCase();
  if (lower.includes("/api/v1/realms")) return base;
  if (lower.includes("/api/v1/realm")) {
    return base.replace(/\/api\/v1\/realm/i, "/api/v1/realms");
  }
  if (lower.endsWith("/realm")) return `${base.slice(0, -"/realm".length)}/realms`;
  if (lower.endsWith("/realms")) return base;
  return `${base}/api/v1/realms`;
}

function getMemberBaseUrls() {
  const realm = buildRealmBaseUrl();
  const realms = buildRealmsBaseUrl();
  return Array.from(new Set(realm === realms ? [realm] : [realms, realm]));
}

function getCredentialsBaseUrls() {
  const realms = buildRealmsBaseUrl();
  const realm = buildRealmBaseUrl();
  return Array.from(new Set(realms === realm ? [realms] : [realms, realm]));
}

function uniqueNonEmpty(values) {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function getCharmRewardAmount(score) {
  if (score > 20) return 500;
  if (score > 10) return 100;
  return 50;
}

function buildAuthHeader(apiKey) {
  if (!apiKey) return undefined;
  if (apiKey.toLowerCase().startsWith("bearer ")) return apiKey;
  return `Bearer ${apiKey}`;
}

const DRIP_TIMEOUT_MS = Number(process.env.DRIP_TIMEOUT_MS) || 30_000;
const DRIP_RETRY_COUNT = Number(process.env.DRIP_RETRY_COUNT) || 2;
const DRIP_OVERRIDE_CACHE_TTL_MS =
  Number(process.env.DRIP_OVERRIDE_CACHE_TTL_MS) || 5 * 60_000;
const DRIP_OVERRIDE_FAILURE_COOLDOWN_MS =
  Number(process.env.DRIP_OVERRIDE_FAILURE_COOLDOWN_MS) || 60_000;
const senderMemberSearchCache = new Map();
const dripUserOverrideCache = new Map();
let dripOverrideLookupBlockedUntil = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function summarizeAxiosError(err) {
  return {
    message: err?.message || String(err),
    code: err?.code || null,
    status: err?.response?.status || null,
    data: err?.response?.data || null,
    url: err?.config?.url || null,
    method: err?.config?.method || null,
  };
}

function logDripAttempt(step, details) {
  console.log(`[GAUNTLET:DRIP] ${step} ${safeJson(details)}`);
}

function logDripFailure(step, details, err) {
  console.error(
    `[GAUNTLET:DRIP] ${step} failed ${safeJson({
      ...details,
      error: summarizeAxiosError(err),
    })}`
  );
}

async function getWithRetry(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt <= DRIP_RETRY_COUNT; attempt += 1) {
    try {
      return await axios.get(url, opts);
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const isRetryable =
        !status || status >= 500 || err?.code === "ECONNABORTED";
      if (!isRetryable || attempt === DRIP_RETRY_COUNT) break;
      const backoff = 500 * Math.pow(2, attempt);
      await wait(backoff);
    }
  }
  throw lastErr;
}

function clearSenderMemberCache(dripSenderId) {
  const key = String(dripSenderId || "").trim();
  if (!key) return;
  senderMemberSearchCache.delete(key);
}

async function getSenderMemberCached(dripSenderId, loader) {
  const key = String(dripSenderId || "").trim();
  if (!key) return null;
  if (senderMemberSearchCache.has(key)) {
    return senderMemberSearchCache.get(key);
  }
  const pendingLookup = (async () => {
    try {
      return await loader();
    } catch (err) {
      clearSenderMemberCache(key);
      throw err;
    }
  })();
  senderMemberSearchCache.set(key, pendingLookup);
  return pendingLookup;
}

async function getDripUserOverrideCached(discordUserId) {
  const key = String(discordUserId || "").trim();
  if (!key) return null;

  const now = Date.now();
  if (dripOverrideLookupBlockedUntil > now) {
    return null;
  }

  const cached = dripUserOverrideCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const override = await Store.getDripUserOverride(key);
    dripUserOverrideCache.set(key, {
      value: override || null,
      expiresAt: now + DRIP_OVERRIDE_CACHE_TTL_MS,
    });
    return override || null;
  } catch (err) {
    dripOverrideLookupBlockedUntil = now + DRIP_OVERRIDE_FAILURE_COOLDOWN_MS;
    console.warn(
      "[GAUNTLET:DRIP] Override lookup failed, pausing override DB lookups briefly:",
      err?.message || err
    );
    return null;
  }
}

async function rewardCharmAmount({
  userId,
  username,
  amount,
  source,
  guildId,
  channelId,
  metadata,
  logClient,
  logReason,
}) {
  logEnvOnce();
  if (!DRIP_API_KEY || !DRIP_REALM_ID) {
    console.warn(
      "[GAUNTLET:DRIP] Missing DRIP_API_KEY or DRIP_REALM_ID. Skipping reward."
    );
    if (logClient) {
      await logCharmReward(logClient, {
        userId,
        amount,
        score: 0,
        source,
        channelId,
        reason: `${logReason || source} payout failed (missing DRIP env)`,
      });
    }
    return { ok: false, skipped: true };
  }

  const auth = buildAuthHeader(DRIP_API_KEY);
  const memberBaseUrls = getMemberBaseUrls().map(
    (base) => `${base}/${DRIP_REALM_ID}`
  );
  const credentialBaseUrls = getCredentialsBaseUrls().map(
    (base) => `${base}/${DRIP_REALM_ID}`
  );
  const dripInitiatorId =
    String(metadata?.dripInitiatorId || "").trim() ||
    String(DRIP_INITIATOR_ID || "").trim() ||
    String(DRIP_CLIENT_ID || "").trim() ||
    null;
  const dripSenderId =
    String(metadata?.dripSenderId || "").trim() ||
    String(DRIP_SENDER_ID || "").trim() ||
    dripInitiatorId ||
    null;
  logDripAttempt("reward:start", {
    userId: String(userId || ""),
    username: username || null,
    amount,
    source: source || null,
    guildId: guildId || null,
    channelId: channelId || null,
    dripInitiatorId,
    dripSenderId,
    hasRealmPointId: Boolean(DRIP_REALM_POINT_ID),
    allowProjectFallback: DRIP_ALLOW_PROJECT_PAYOUT_FALLBACK,
    memberBaseUrls,
    credentialBaseUrls,
    metadata: metadata || null,
  });

  let baseUsed = memberBaseUrls[0];
  try {
    const credentialPayloads = DRIP_REALM_POINT_ID
      ? [
          { amount, realmPointId: DRIP_REALM_POINT_ID },
          { amount },
        ]
      : [{ amount }];
    const credentialPatchOpts = {
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      timeout: DRIP_TIMEOUT_MS,
    };

    const tryCredentialBalancePatch = async (type, value, label) => {
      const cleanType = String(type || "").trim();
      const cleanValue = String(value || "").trim();
      if (!cleanType || !cleanValue) return false;

      for (const baseUrl of credentialBaseUrls) {
        baseUsed = baseUrl;
        const transactionUrl = `${baseUrl}/credentials/transaction`;
        for (const payload of credentialPayloads) {
          try {
            const transactionPayload = {
              updates: [
                {
                  type: cleanType,
                  value: cleanValue,
                  amount,
                  source: source || "gauntlet",
                  ...(payload?.realmPointId
                    ? { realmPointId: payload.realmPointId }
                    : {}),
                },
              ],
              ...(dripInitiatorId ? { initiatorId: dripInitiatorId } : {}),
            };
            if (DRIP_DEBUG) {
              logDripAttempt("credentials/transaction:request", {
                type: cleanType,
                value: cleanValue,
                valueType: typeof cleanValue,
                valueLen: cleanValue.length,
                initiatorId: dripInitiatorId || null,
                url: transactionUrl,
                payload: transactionPayload,
              });
            }
            const response = await axios.patch(
              transactionUrl,
              transactionPayload,
              credentialPatchOpts
            );
            const txErrors = Array.isArray(response?.data?.errors)
              ? response.data.errors
              : [];
            if (txErrors.length) {
              const firstError = txErrors[0];
              const err = new Error(firstError?.error || "credential_transaction_failed");
              err.response = {
                status: 400,
                data: response.data,
              };
              throw err;
            }
            console.log(
              `[GAUNTLET:DRIP] Rewarded ${amount} $CHARM to ${userId} (${source}) via credentials/transaction (${label || `${cleanType}:${cleanValue}`})${dripInitiatorId ? ` initiator=${dripInitiatorId}` : ""}.`
            );
            return true;
          } catch (err) {
            const status = err?.response?.status;
            const data = err?.response?.data;
            const transactionError = Array.isArray(data?.errors)
              ? data.errors[0]?.error
              : null;
            const missingCredential =
              status === 404 ||
              status === 400 ||
              /not found|missing|credential/i.test(String(transactionError || ""));

            // Keep trying other payloads/bases/types when DRIP can't resolve this credential.
            if (missingCredential) {
              logDripFailure(
                "credentials/transaction",
                {
                  type: cleanType,
                  value: cleanValue,
                  label: label || `${cleanType}:${cleanValue}`,
                  url: transactionUrl,
                  payload: transactionPayload,
                  missingCredential: true,
                },
                err
              );
            } else {
              throw err;
            }

            const patchUrl = `${baseUrl}/credentials/balance?type=${encodeURIComponent(
              cleanType
            )}&value=${encodeURIComponent(cleanValue)}`;
            try {
              if (DRIP_DEBUG) {
                logDripAttempt("credentials/balance:request", {
                  type: cleanType,
                  value: cleanValue,
                  url: patchUrl,
                  payload,
                });
              }
              await axios.patch(patchUrl, payload, credentialPatchOpts);
              console.log(
                `[GAUNTLET:DRIP] Rewarded ${amount} $CHARM to ${userId} (${source}) via legacy credentials/balance (${label || `${cleanType}:${cleanValue}`}).`
              );
              return true;
            } catch (fallbackErr) {
              const fallbackStatus = fallbackErr?.response?.status;
              if (fallbackStatus === 404 || fallbackStatus === 400) {
                logDripFailure(
                  "credentials/balance",
                  {
                    type: cleanType,
                    value: cleanValue,
                    label: label || `${cleanType}:${cleanValue}`,
                    url: patchUrl,
                    payload,
                    missingCredential: true,
                  },
                  fallbackErr
                );
                continue;
              }
              throw fallbackErr;
            }
          }
        }
      }
      return false;
    };

    const tryMemberBalancePatchByDripId = async (dripId, label) => {
      const cleanDripId = String(dripId || "").trim();
      if (!cleanDripId) return false;

      const modernPayloads = DRIP_REALM_POINT_ID
        ? [
            {
              amount,
              currencyId: DRIP_REALM_POINT_ID,
              ...(dripInitiatorId ? { initiatorId: dripInitiatorId } : {}),
            },
            {
              amount,
              ...(dripInitiatorId ? { initiatorId: dripInitiatorId } : {}),
            },
          ]
        : [
            {
              amount,
              ...(dripInitiatorId ? { initiatorId: dripInitiatorId } : {}),
            },
          ];
      const legacyPayload = {
        tokens: amount,
        ...(DRIP_REALM_POINT_ID ? { realmPointId: DRIP_REALM_POINT_ID } : {}),
      };
      const patchOpts = {
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        timeout: DRIP_TIMEOUT_MS,
      };

      for (const baseUrl of memberBaseUrls) {
        baseUsed = baseUrl;
        const modernUrl = `${baseUrl}/members/${encodeURIComponent(cleanDripId)}/balance`;
        for (const payload of modernPayloads) {
          try {
            if (DRIP_DEBUG) {
              logDripAttempt("members/balance:request", {
                dripId: cleanDripId,
                url: modernUrl,
                payload,
              });
            }
            await axios.patch(modernUrl, payload, patchOpts);
            console.log(
              `[GAUNTLET:DRIP] Rewarded ${amount} $CHARM to ${userId} (${source}) via members/{dripId}/balance (${label || cleanDripId}).`
            );
            return true;
          } catch (err) {
            const status = err?.response?.status;
            if (status === 404 || status === 400) {
              logDripFailure(
                "members/balance",
                {
                  dripId: cleanDripId,
                  label: label || cleanDripId,
                  url: modernUrl,
                  payload,
                },
                err
              );
              continue;
            }
            throw err;
          }
        }
      }

      // Backward-compatible fallback for older DRIP routes.
      for (const baseUrl of memberBaseUrls) {
        baseUsed = baseUrl;
        const legacyUrl = `${baseUrl}/members/${encodeURIComponent(
          cleanDripId
        )}/point-balance`;
        try {
          if (DRIP_DEBUG) {
            logDripAttempt("members/point-balance:request", {
              dripId: cleanDripId,
              url: legacyUrl,
              payload: legacyPayload,
            });
          }
          await axios.patch(legacyUrl, legacyPayload, patchOpts);
          console.log(
            `[GAUNTLET:DRIP] Rewarded ${amount} $CHARM to ${userId} (${source}) via legacy members/{id}/point-balance (${label || cleanDripId}).`
          );
          return true;
        } catch (err) {
          const status = err?.response?.status;
          if (status === 404) {
            logDripFailure(
              "members/point-balance",
              {
                dripId: cleanDripId,
                label: label || cleanDripId,
                url: legacyUrl,
                payload: legacyPayload,
              },
              err
            );
            continue;
          }
          throw err;
        }
      }

      return false;
    };

    const searchMemberByType = async (type, value) => {
      const cleanType = String(type || "").trim();
      const cleanValue = String(value || "").trim();
      if (!cleanType || !cleanValue) return null;

      let lastSearchErr = null;
      let hadSuccessfulLookup = false;
      for (const baseUrl of memberBaseUrls) {
        try {
          baseUsed = baseUrl;
          const searchUrl = `${baseUrl}/members/search?type=${encodeURIComponent(
            cleanType
          )}&values=${encodeURIComponent(cleanValue)}`;
          logDripAttempt("members/search:request", {
            type: cleanType,
            value: cleanValue,
            url: searchUrl,
          });
          const search = await getWithRetry(searchUrl, {
            headers: { Authorization: auth },
            timeout: DRIP_TIMEOUT_MS,
          });
          hadSuccessfulLookup = true;
          const found = search?.data?.data?.[0] || null;
          logDripAttempt("members/search:response", {
            type: cleanType,
            value: cleanValue,
            url: searchUrl,
            found: found
              ? {
                  id: found.id || null,
                  realmMemberId: found.realmMemberId || null,
                  dynamicId: found.dynamicId || null,
                  username: found.username || null,
                  discordId: found.discordId || null,
                }
              : null,
            rawCount: Array.isArray(search?.data?.data) ? search.data.data.length : null,
          });
          if (found?.id) return found;
        } catch (err) {
          lastSearchErr = err;
          logDripFailure(
            "members/search",
            {
              type: cleanType,
              value: cleanValue,
              baseUrl,
            },
            err
          );
          if (err?.response?.status !== 404) throw err;
        }
      }
      if (lastSearchErr && !hadSuccessfulLookup) throw lastSearchErr;
      return null;
    };

    const transferPointsFromMember = async (recipientMember, label) => {
      const recipientIdCandidates = uniqueNonEmpty([
        recipientMember?.id,
      ]);
      if (!dripSenderId || !recipientIdCandidates.length) return false;

      const patchOpts = {
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        timeout: DRIP_TIMEOUT_MS,
      };

      let senderMember = null;
      try {
        senderMember = await getSenderMemberCached(dripSenderId, () =>
          searchMemberByType("drip-id", dripSenderId)
        );
      } catch (err) {
        logDripFailure(
          "members/transfer:sender-resolve",
          { senderId: dripSenderId },
          err
        );
      }

      const senderIdCandidates = uniqueNonEmpty([
        senderMember?.id,
        dripSenderId,
      ]);
      const transferBaseUrls = memberBaseUrls.filter((baseUrl) =>
        /\/api\/v1\/realms\//i.test(baseUrl)
      );
      const activeTransferBaseUrls = transferBaseUrls.length
        ? transferBaseUrls
        : memberBaseUrls;
      const payloadBases = DRIP_REALM_POINT_ID
        ? [
            { amount, currencyId: DRIP_REALM_POINT_ID },
            { tokens: amount, realmPointId: DRIP_REALM_POINT_ID },
            { amount },
            { tokens: amount },
          ]
        : [{ amount }, { tokens: amount }];

      for (const baseUrl of activeTransferBaseUrls) {
        for (const senderIdCandidate of senderIdCandidates) {
          baseUsed = baseUrl;
          const transferUrl = `${baseUrl}/members/${encodeURIComponent(
            senderIdCandidate
          )}/transfer`;
          for (const recipientIdCandidate of recipientIdCandidates) {
            for (const payloadBase of payloadBases) {
              const transferPayload = {
                ...payloadBase,
                recipientId: recipientIdCandidate,
              };
              try {
                logDripAttempt("members/transfer:request", {
                  senderId: senderIdCandidate,
                  senderCandidates: senderIdCandidates,
                  recipientId: recipientIdCandidate,
                  recipientCandidates: recipientIdCandidates,
                  amount,
                  source: source || null,
                  label: label || recipientIdCandidate,
                  url: transferUrl,
                  payload: transferPayload,
                });
                await axios.patch(transferUrl, transferPayload, patchOpts);
                console.log(
                  `[GAUNTLET:DRIP] Transferred ${amount} $CHARM from ${senderIdCandidate} to ${recipientIdCandidate} for Discord ${userId} (${source}) via members/{senderId}/transfer (${label || recipientIdCandidate}).`
                );
                return true;
              } catch (err) {
                const status = err?.response?.status;
                logDripFailure(
                  "members/transfer",
                  {
                    senderId: senderIdCandidate,
                    senderCandidates: senderIdCandidates,
                    recipientId: recipientIdCandidate,
                    recipientCandidates: recipientIdCandidates,
                    amount,
                    source: source || null,
                    label: label || recipientIdCandidate,
                    url: transferUrl,
                    payload: transferPayload,
                  },
                  err
                );
                if (status === 404 || status === 400) {
                  if (status === 404 && senderIdCandidate === dripSenderId) {
                    clearSenderMemberCache(dripSenderId);
                  }
                  continue;
                }
                throw err;
              }
            }
          }
        }
      }

      return false;
    };

    const maybeLogAndReturnSkipped = async (reason) => {
      if (logClient) {
        await logCharmReward(logClient, {
          userId,
          amount,
          score: 0,
          source,
          channelId,
          reason: `${logReason || source} payout failed (${reason})`,
        });
      }
      return { ok: false, skipped: true, reason };
    };

    const credentialValue =
      typeof userId === "string" ? userId : String(userId || "");
    if (!credentialValue) {
      throw new Error("missing_discord_id");
    }

    // Preferred path: resolve recipient member ID, then transfer from the configured sender balance.
    const manualOverride = await getDripUserOverrideCached(String(userId || ""));

    let recipientMember = null;
    if (manualOverride?.drip_user_id) {
      const overrideValue = String(manualOverride.drip_user_id).trim();
      const configuredType = String(
        manualOverride.drip_credential_type || "drip-id"
      ).trim();

      if (
        ["drip-id", "id", "member-id", "user-id"].includes(configuredType)
      ) {
        recipientMember = {
          id: overrideValue,
          username: null,
        };
      } else {
        recipientMember = await searchMemberByType(configuredType, overrideValue);
      }

      if (!recipientMember?.id) {
        const overrideTypes = [
          configuredType,
          ...["drip-id", "id", "member-id", "user-id", "discord-id", "username"].filter(
            (t) => t !== configuredType
          ),
        ];
        for (const type of overrideTypes) {
          recipientMember = await searchMemberByType(type, overrideValue);
          if (recipientMember?.id) break;
        }
      }
    }

    if (!recipientMember?.id) {
      recipientMember = await searchMemberByType("discord-id", credentialValue);
    }
    if (!recipientMember?.id && username) {
      recipientMember = await searchMemberByType("username", username);
    }
    logDripAttempt("recipient:resolved", {
      userId: credentialValue,
      username: username || null,
      manualOverride: manualOverride
        ? {
            drip_user_id: manualOverride.drip_user_id || null,
            drip_credential_type: manualOverride.drip_credential_type || null,
          }
        : null,
      recipientMember: recipientMember
        ? {
            id: recipientMember.id || null,
            realmMemberId: recipientMember.realmMemberId || null,
            dynamicId: recipientMember.dynamicId || null,
            username: recipientMember.username || null,
          }
        : null,
    });

    if (!recipientMember?.id) {
      console.warn(
        `[GAUNTLET:DRIP] No DRIP member found for Discord ID ${userId}.`
      );
      return maybeLogAndReturnSkipped(
        manualOverride?.drip_user_id ? "manual_override_failed" : "member_not_found"
      );
    }

    {
      const okByTransfer = await transferPointsFromMember(
        recipientMember,
        manualOverride?.drip_user_id
          ? `manual-override recipient:${recipientMember.id}`
          : `search-result recipient:${recipientMember.id}`
      );
      if (okByTransfer) return { ok: true, amount, mode: "transfer" };
    }

    if (!DRIP_ALLOW_PROJECT_PAYOUT_FALLBACK) {
      console.warn(
        `[GAUNTLET:DRIP] Transfer payout failed for recipient ${recipientMember.id}; project fallback disabled. sender=${dripSenderId} amount=${amount} realmPointId=${DRIP_REALM_POINT_ID || "none"}`
      );
      return maybeLogAndReturnSkipped("transfer_failed");
    }

    {
      const okByMemberId = await tryMemberBalancePatchByDripId(
        recipientMember.id,
        `project-fallback drip-id:${recipientMember.id}`
      );
      if (okByMemberId) return { ok: true, amount, mode: "project-fallback" };
    }

    {
      const ok = await tryCredentialBalancePatch(
        "discord-id",
        credentialValue,
        "project-fallback discord-id"
      );
      if (ok) return { ok: true, amount, mode: "project-fallback" };
    }

    console.warn(
      `[GAUNTLET:DRIP] Recipient ${recipientMember.id} resolved but payout could not complete.`
    );
    return maybeLogAndReturnSkipped("transfer_failed");
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error(
      "[GAUNTLET:DRIP] Reward failed:",
      status || err.message,
      data || "",
      `url=${baseUsed}`
    );
    if (logClient) {
      await logCharmReward(logClient, {
        userId,
        amount,
        score: 0,
        source,
        channelId,
        reason: `${logReason || source} payout failed (${status || err.message})`,
      });
    }
    return { ok: false, error: err };
  }
}

async function rewardCharm({
  userId,
  username,
  score,
  source,
  guildId,
  channelId,
  logClient,
  logReason,
}) {
  const amount = getCharmRewardAmount(score);
  return rewardCharmAmount({
    userId,
    username,
    amount,
    source,
    guildId,
    channelId,
    metadata: { score },
    logClient,
    logReason,
  });
}

async function logCharmReward(
  client,
  { userId, amount, score, source, channelId, reason }
) {
  const targetChannelId = DRIP_LOG_CHANNEL_ID || channelId;
  if (!client || !targetChannelId) return false;
  try {
    const ch = await client.channels.fetch(targetChannelId);
    if (!ch || !ch.send) return false;
    const reasonText = reason || source || "Gauntlet";
    const isFailure = /failed/i.test(reasonText);
    const failureHelp = [
      "How to Connect to DRIP",
      "",
      "1. Go to https://app.drip.re/user/profile",
      "2. Open the Linked Accounts tab",
      "3. Connect your Discord",
      "4. Connect your Wallet",
      "",
      "That's it — you're linked and ready to go",
      "",
      "If it still doesn't work, open a support ticket with a screenshot and the team will help get it sorted.",
    ].join("\n");
    const message = isFailure
      ? `PAYOUT FAILED: <@${userId}> | ${amount} $CHARM | ${reasonText}\n\n${failureHelp}`
      : `<@${userId}> received **${amount} $CHARM** for ${reasonText}.`;
    await ch.send(message);
    return true;
  } catch (err) {
    console.error("[GAUNTLET:DRIP] Reward log failed:", err?.message || err);
    return false;
  }
}

module.exports = {
  getCharmRewardAmount,
  rewardCharmAmount,
  rewardCharm,
  DRIP_LOG_CHANNEL_ID,
  logCharmReward,
};
