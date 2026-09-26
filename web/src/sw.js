// Service worker: receives push notifications while the app is closed.
// The Firebase config is passed in the registration URL (?config=...).
import { initializeApp } from "firebase/app";
import { getMessaging, onBackgroundMessage } from "firebase/messaging/sw";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const raw = new URL(self.location.href).searchParams.get("config");
if (raw) {
  const messaging = getMessaging(initializeApp(JSON.parse(raw)));
  // Messages carry a `notification` block, so Firebase shows them for us and
  // opens the link when tapped. Nothing extra to do here.
  onBackgroundMessage(messaging, () => {});
}
