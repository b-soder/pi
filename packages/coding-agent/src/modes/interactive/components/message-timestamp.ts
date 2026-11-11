// A pane-width divider displaying the message's original local timestamp.
import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Render a timestamp divider at the current chat pane width, including after resize. */
export class MessageTimestampComponent implements Component {
	private label: string;

	constructor(timestamp: number) {
		const date = new Date(timestamp);
		const pad = (value: number) => String(value).padStart(2, "0");
		this.label = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const label = ` ${this.label} `;
		// Narrow panes clip the date rather than overflowing into an adjacent panel.
		if (width < label.length) return [theme.fg("messageTimestamp", this.label.slice(0, width).padEnd(width))];
		const left = Math.floor((width - label.length) / 2);
		const line = "─".repeat(left) + label + "─".repeat(width - label.length - left);
		return [theme.fg("messageTimestamp", line)];
	}
}
