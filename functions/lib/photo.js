// Uses Gemini to look at the medicine photo and compare it with the last one.
import { GoogleGenAI, Type } from "@google/genai";

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    medicinesVisible: {
      type: Type.BOOLEAN,
      description: "True if medicine strips/bottles are clearly visible in the NEW photo.",
    },
    medicines: {
      type: Type.ARRAY,
      description: "Each distinct medicine visible in the NEW photo.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "Name printed on the pack, or a short description." },
          remaining: { type: Type.INTEGER, description: "Best estimate of tablets left. -1 if unknown." },
          remainingInPrevious: {
            type: Type.INTEGER,
            description: "Best estimate for the same medicine in the PREVIOUS photo. -1 if unknown or no previous photo.",
          },
        },
        required: ["name", "remaining", "remainingInPrevious"],
      },
    },
    verdict: {
      type: Type.STRING,
      enum: ["consistent", "inconsistent", "unsure"],
      description:
        "Whether the tablets used since the previous photo roughly match the doses she reported taking.",
    },
    lowSupply: { type: Type.BOOLEAN, description: "True if any medicine looks like it will run out within ~5 days." },
    retakeAdvice: {
      type: Type.STRING,
      description: "If the photo is unusable, a very short instruction in simple Hinglish for Mummy. Otherwise empty.",
    },
    summary: { type: Type.STRING, description: "2-3 short sentences in English for her son/daughter." },
  },
  required: ["medicinesVisible", "medicines", "verdict", "lowSupply", "retakeAdvice", "summary"],
};

/**
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {{data: Buffer, mimeType: string}} p.image
 * @param {{data: Buffer, mimeType: string, takenAt: string}|null} p.previous
 * @param {{taken: number, missed: number, since: string, dosesPerDay: number}} p.log
 */
export async function analyzePhoto({ apiKey, model, image, previous, log }) {
  const ai = new GoogleGenAI({ apiKey });

  const intro = previous
    ? `You are helping someone check that their elderly mother, who lives alone, is taking her daily medicines ` +
      `(${log.dosesPerDay} times a day). Image 1 is the PREVIOUS photo of her medicines (taken ${previous.takenAt}). ` +
      `Image 2 is the NEW photo (taken now). Since the previous photo, the reminder app recorded ${log.taken} doses ` +
      `confirmed as taken and ${log.missed} doses missed or unanswered. ` +
      `Count the tablets remaining in each blister strip or bottle in both photos (empty blister pockets = used). ` +
      `Decide whether the number of tablets used roughly matches the confirmed doses. Some medicines may be taken ` +
      `only once a day or more than one tablet at a time, so allow for that and prefer "unsure" when unclear.`
    : `You are helping someone check that their elderly mother, who lives alone, is taking her daily medicines ` +
      `(${log.dosesPerDay} times a day). This is the FIRST photo of her medicines, so there is nothing to compare ` +
      `with yet: set verdict to "unsure", remainingInPrevious to -1, and record what you can see so the next photo ` +
      `can be compared.`;

  const parts = [{ text: intro }];
  if (previous) parts.push({ inlineData: { mimeType: previous.mimeType, data: previous.data.toString("base64") } });
  parts.push({ inlineData: { mimeType: image.mimeType, data: image.data.toString("base64") } });

  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2 },
  });
  return JSON.parse(res.text);
}

export function formatAnalysis(a) {
  const icon = { consistent: "✅", inconsistent: "⚠️", unsure: "❓" }[a.verdict] || "❓";
  const meds = (a.medicines || [])
    .map((m) => `${m.name}: ${m.remaining >= 0 ? m.remaining : "?"} left` +
      (m.remainingInPrevious >= 0 ? ` (was ${m.remainingInPrevious})` : ""))
    .join("; ");
  return [
    `${icon} ${a.summary}`,
    meds && `💊 ${meds}`,
    a.lowSupply && "🛒 Running low — time to refill.",
  ].filter(Boolean).join("\n");
}
