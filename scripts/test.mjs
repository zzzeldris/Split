import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});

const response = await ai.models.generateContent({
  model: "gemini-3.5-flash",
  contents: "Say hello in one short sentence.",
});

console.log(response.text);