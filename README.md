# MomMeds 💊

A very simple medicine reminder for Mummy's iPhone, in Hindi.

- **12:30 PM and 9:00 PM** her phone asks *"Mummy, dawaii kha liye?"*: a notification, then your voice when she opens it.
- She taps the big green **हाँ / Haan** button (or says it). If she taps **नहीं / Nahi** or doesn't answer, she is asked again **every 30 minutes**.
- After **4 unanswered reminders (2 hours)** you get an alert. After 8, the reminders stop and the dose is marked missed.
- Every **3 days** at 6 PM she is asked *"Mummy, dawaii ki bag ka photo bhejo"*. **Gemini** counts the tablets, compares them with the previous photo and the reminder log, and tells you whether the two match and when she's running low.
- You (and any brothers or sisters) install the same app as **admin**. You get the alerts, a 14-day history, the photo checks, and buttons to remind her or ask for a photo.

It is a web app (PWA) hosted on Firebase, so **no App Store, no Apple developer account**. You add it to the Home Screen from Safari.

```
Mummy's iPhone (Home Screen app)  ⇄  Firebase Cloud Functions  ⇄  Firestore / Storage
        ▲ push notifications              │ every 5 min: who needs a reminder?
        └──────── Firebase Cloud Messaging┘ → Gemini for photos → push/WhatsApp to admins
```

---

## One-time setup (≈30 minutes, on a laptop)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** (e.g. `mommeds`). Google Analytics isn't needed.
2. **Upgrade to the Blaze (pay-as-you-go) plan.** Scheduled functions require it. At this usage it stays inside the free tier, which should mean ₹0/$0 a month. Set a budget alert of e.g. $5 to be safe.
3. **Build → Authentication → Get started → Email/Password → Enable.**
   Then under **Users → Add user**, create two logins:
   - one for Mummy, e.g. `mummy.meds@gmail.com` (it doesn't need to be a real inbox) with a simple password
   - one for yourself
4. **Build → Firestore Database → Create database**. Choose the **production** rules and location **asia-south1 (Mumbai)**.
5. **Build → Storage → Get started**, same location.
6. **Project settings (⚙️) → Cloud Messaging → Web Push certificates → Generate key pair.** Copy the key. This is your `VAPID_KEY`.

### 2. Get a Gemini API key
Go to <https://aistudio.google.com/apikey> → **Create API key**. Choose the same Google Cloud project if it's offered.

### 3. Deploy
You need [Node.js 22](https://nodejs.org).

```bash
npm install -g firebase-tools
firebase login

git clone https://github.com/minazkh/mommeds && cd mommeds
npm install
npm --prefix functions install

# Put your project id in .firebaserc (replace "your-firebase-project-id")
cp functions/.env.example functions/.env    # then edit it: emails, VAPID_KEY, times
firebase functions:secrets:set GEMINI_API_KEY   # paste the Gemini key

firebase deploy
```

The app is now live at `https://<your-project-id>.web.app`.

> If the first deploy complains about APIs being enabled or Eventarc/Cloud Scheduler permissions, wait a minute and run `firebase deploy` again. This is normal for a new project.

---

## Install on YOUR phone (admin)
1. Open `https://<your-project-id>.web.app` in **Safari** (on iPhone; on Android, use Chrome).
2. **Share → Add to Home Screen → Add.**
3. Open **MomMeds** from the Home Screen, log in with *your* email, tap **Turn on**, then **Allow**.
4. Tap **Test my notifications**. You should get one.

## Install on MUMMY'S iPhone
Do this in person or over a video call. It needs **iOS 16.4 or newer** (Settings → General → About).

1. Open `https://<your-project-id>.web.app` in **Safari**. It must be Safari, not Chrome or WhatsApp's browser.
2. **Share → Add to Home Screen → Add.** Move the icon to her first Home Screen page.
3. Open **MomMeds** from the Home Screen, log in with *her* email. She stays logged in.
4. Tap **Chalu karein**, then **Allow**.
5. On your phone, tap **Test Mummy's phone** and check that her phone buzzes.
6. On her iPhone, check:
   - **Settings → Notifications → MomMeds**: Allow Notifications, **Sounds** and **Lock Screen** on, Banner Style **Persistent**.
   - **Settings → Focus** (Do Not Disturb / Sleep): add **MomMeds** to allowed apps, or make sure no Focus is on at 12:30 and 9 PM.
   - Media volume up, so she can hear your voice when the app opens.

To show her: *"Jab phone bajega, notification pe dabao, phir hara button dabao."*

---

## Good to know
- **Your voice** plays when she opens the app from the notification. iPhones don't allow custom sounds for web-app notifications, so the notification itself uses the normal iPhone sound. If the voice doesn't start by itself (iPhone sometimes blocks autoplay), she can tap the question text 🔊 to hear it.
- **Voice answer** ("🎤 Bol ke batao") uses Apple's dictation. Siri and Dictation must be enabled on her phone. The big buttons always work.
- **"Maine dawaii kha li"**: if she takes it up to 3 hours early, she can tap this button and won't be reminded.
- **You can answer for her.** If she tells you on the phone that she took it, open **👀 Mummy's screen** and tap Haan. It's logged as "marked by admin".
- **Photos**: ask her to lay all the strips flat so the pockets are visible. Treat the Gemini check as an early warning, not proof.
- **Changing times or settings**: edit `functions/.env` and run `firebase deploy --only functions`.
- **Privacy**: the database and storage are locked. Only the Cloud Functions read them, and only for the emails in `functions/.env`.

### Optional: alerts on WhatsApp too
Admin push notifications work out of the box. To also get the *urgent* alerts (no answer, missed dose, photo problems) on WhatsApp, use the free [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) service:
1. Save **+34 644 71 81 99** in your contacts and send it the WhatsApp message `I allow callmebot to send me messages`.
2. It replies with an API key. Put your number (with country code, e.g. `+919812345678`) and the key in `functions/.env` as `WHATSAPP_PHONE` and `WHATSAPP_APIKEY`, then run `firebase deploy --only functions`.

---

## Development
```bash
npm test            # scheduling logic tests
npm run demo        # preview the screens without Firebase:
                    #   http://localhost:5000/?demo=ask | photo | home | admin
```

| Path | What |
|---|---|
| `functions/lib/schedule.js` | When to remind, alert, and ask for photos (pure logic, tested) |
| `functions/index.js` | Scheduler (every 5 min) and the app's API |
| `functions/lib/photo.js` | Gemini photo check |
| `web/src/app.js` | The app: Mummy's screens and the admin dashboard |
| `web/public/audio/` | Your voice recordings (`ask-dose.m4a`, `ask-photo.m4a`) |
