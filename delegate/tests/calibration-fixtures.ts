import { fingerprint, keyId, type CalibrationKey, type SavingsSnapshot, type Pricing } from "../calibration.ts";
export const key: CalibrationKey = { localModel: "local-qwen38/qwen38-q4km", alternativeModel: "openai-codex/gpt-5.6-luna", kind: "recon", localThinking: "off", alternativeThinking: "low", tools: ["read"], promptHash: fingerprint("prompt") };
export const pricing: Pricing = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
export const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });
export function savings(now = new Date()): SavingsSnapshot {
	return { version: 1, profile: {
		version: 1, id: keyId(key), createdAt: now.toISOString(), key: structuredClone(key), suiteHash: fingerprint("suite"),
		pairs: 4, acceptedPairs: 4, localFailures: 0, alternativeFailures: 0, incompletePairs: 0,
		promptRatio: 0.5, outputRatio: 0.5, cacheReadShare: 0.5, cacheWriteShare: 0, totalRatioRange: [0.5, 0.5],
	}, pricing: structuredClone(pricing), pricedAt: now.toISOString() };
}
