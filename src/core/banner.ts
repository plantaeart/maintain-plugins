/**
 * Cell width of banner text. Not pi-tui's visibleWidth: omp 19 no longer
 * provides that module, so importing it fails the whole extension load.
 *
 * shortcut: one cell per code point (VS16 dropped), so wide CJK/emoji undercount;
 * the banner holds ASCII plus ⬆️ only. Upgrade if plugin names go non-ASCII.
 */
const visibleWidth = (text: string): number => [...text.replaceAll("\uFE0F", "")].length;

/**
 * Draw the notice as an open-right box: top rule, left edge, bottom rule.
 *
 * Deliberately no right border, which means the rows need no padding to line
 * up — only the two rules do, and both are drawn to the widest row. A closed
 * box would have to pad every row to a common display width, and an emoji
 * like ⬆️ occupies one cell while its string is two code points, so a naive
 * pad leaves every emoji row a column short.
 */
export function boxBanner(title: string, rows: string[]): string[] {
	const widest = Math.max(
		visibleWidth(title) + 4,
		...rows.map((row) => visibleWidth(row) + 2),
	);
	return [
		`╭─ ${title} ${"─".repeat(Math.max(1, widest - visibleWidth(title) - 4))}`,
		...rows.map((row) => `│ ${row}`),
		`╰─${"─".repeat(Math.max(1, widest - 2))}`,
	];
}
