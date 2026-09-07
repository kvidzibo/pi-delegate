import { fingerprint, fitCalibration, type CalibrationKey, type SavingsSnapshot, type Pricing } from "../calibration.ts";
export const key: CalibrationKey = { localModel: "local-qwen38/qwen38-q4km", alternativeModel: "openai-codex/gpt-5.6-luna", kind: "recon", localThinking: "off", alternativeThinking: "low", tools: ["read"], promptHash: fingerprint("prompt") };
export const pricing: Pricing = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
export const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });
export function samples() {
	return [0,1,2,3].map(i => ({ taskId: `task-${i}`, repeat: 1,
		local: { passed: true, complete: true, tokens: tokens(100, 20, 100) },
		alternative: { passed: true, complete: true, tokens: tokens(50, 10, 50) },
	}));
}
export function savings(now = new Date()): SavingsSnapshot {
	return { version: 1, profile: fitCalibration(key, fingerprint("suite"), samples(), now), pricing: structuredClone(pricing), pricedAt: now.toISOString() };
}
