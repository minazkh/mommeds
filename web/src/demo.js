// Fake backend for previewing screens without Firebase: /?demo=ask | photo | home | admin
export function demoApi(mode) {
  const now = Date.now();
  const h = 3600000;
  const slot = (time, label, nice) => ({ id: `demo_${time}`, date: "2026-09-26", time, label, nice });
  const doses = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(now - i * 86400000).toISOString().slice(0, 10);
    for (const time of ["12:30", "21:00"]) {
      if (i === 0 && time === "21:00") continue;
      const status = i === 4 && time === "21:00" ? "missed" : i === 0 ? "pending" : "taken";
      doses.push({
        id: `${date}_${time.replace(":", "")}`, date, time, status,
        remindersSent: status === "taken" ? 1 + (i % 3 === 0 ? 2 : 0) : 3,
        takenAt: now - i * 86400000 - h,
      });
    }
  }
  const responses = {
    whoami: { role: mode === "admin" ? "admin" : "mom", vapidKey: "demo" },
    getStatus: {
      current: mode === "ask" ? slot("12:30", "Dopahar", "12:30 PM") : null,
      next: slot("21:00", "Raat", "9:00 PM"),
      early: mode === "home" ? slot("21:00", "Raat", "9:00 PM") : null,
      photoRequested: mode === "photo",
    },
    answerDose: { ok: true },
    uploadPhoto: { ok: true, retakeAdvice: "" },
    adminAction: { sent: 1, devices: 1 },
    adminDashboard: {
      today: new Date(now).toISOString().slice(0, 10),
      config: {
        timezone: "Asia/Kolkata", doseTimes: ["12:30", "21:00"], intervalMin: 30, alertAfter: 4,
        photoEveryDays: 3, photoTime: "18:00", whatsapp: false,
      },
      doses,
      devices: [{ role: "mom" }, { role: "admin" }],
      state: { lastPhotoDate: new Date(now - 2 * 86400000).toISOString().slice(0, 10) },
      view: { next: slot("21:00", "Raat", "9:00 PM") },
      photos: [{
        url: "/icons/icon-512.png",
        createdAt: now - 2 * 86400000,
        log: { since: "x", taken: 6, missed: 0 },
        analysis: {
          verdict: "consistent",
          summary: "About 6 tablets of each strip were used since the last photo, which matches the 6 confirmed doses.",
          medicines: [
            { name: "Telma 40", remaining: 8, remainingInPrevious: 11 },
            { name: "Glycomet 500", remaining: 4, remainingInPrevious: 10 },
          ],
          lowSupply: true,
        },
      }],
    },
  };
  return {
    call: async (name) => {
      await new Promise((r) => setTimeout(r, 150));
      return responses[name];
    },
    signOut: () => location.reload(),
  };
}
