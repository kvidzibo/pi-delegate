// Node's trusted test-event stream keeps project stdout separate from assertion outcomes.
export default async function* report(source) {
	for await (const event of source) {
		yield `${JSON.stringify(event, (_key, value) => value instanceof Error
			? { ...value, name: value.name, message: value.message, stack: value.stack }
			: value)}\n`;
	}
}
