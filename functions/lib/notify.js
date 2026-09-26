// Push notifications (to Mummy or the admins) and optional WhatsApp alerts.
import { createHash } from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";

export function deviceId(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 40);
}

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/** Send a notification to every registered device of a role ("mom" | "admin"). */
export async function pushTo(role, { title, body, link, tag }) {
  const db = getFirestore();
  const snap = await db.collection("devices").where("role", "==", role).get();
  const tokens = snap.docs.map((d) => d.get("token"));
  if (!tokens.length) {
    logger.warn(`No ${role} devices registered; notification not sent`, { title });
    return { sent: 0, devices: 0 };
  }

  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: { tag: tag || "", link },
    webpush: {
      notification: {
        title,
        body,
        icon: "/icons/icon-192.png",
        tag,
        renotify: true,
        requireInteraction: true,
      },
      fcmOptions: { link },
    },
  });

  await Promise.all(
    res.responses.map((r, i) => {
      if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) {
        return db.collection("devices").doc(deviceId(tokens[i])).delete();
      }
      if (!r.success) logger.error("Push failed", { role, code: r.error?.code, message: r.error?.message });
      return null;
    }),
  );
  return { sent: res.successCount, devices: tokens.length };
}

/** Optional free WhatsApp alert via CallMeBot (https://www.callmebot.com). */
export async function whatsapp(phone, apiKey, text) {
  if (!phone || !apiKey) return;
  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) logger.error("WhatsApp alert failed", { status: r.status });
  } catch (e) {
    logger.error("WhatsApp alert failed", e);
  }
}
