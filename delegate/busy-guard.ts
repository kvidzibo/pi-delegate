type BusyQuery = { reply: (busy: boolean) => void };

export function respondToBusyQuery(payload: unknown, busy: boolean): void {
	if (!payload || typeof payload !== "object" || typeof (payload as { reply?: unknown }).reply !== "function") return;
	(payload as BusyQuery).reply(busy);
}
