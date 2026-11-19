// Pure grouping rules for thinking sections in the interactive conversation log.

export type ThinkingEntry = { kind: "thinking"; sections: readonly string[] };
export type OtherConversationEntry = { kind: "other" };
export type ToolLogEntry = { kind: "tool-log-only" };
export type ClassifiedConversationEntry = ThinkingEntry | OtherConversationEntry | ToolLogEntry;

export interface ThinkingGroup {
	sections: string[];
	state: "open" | "closed";
}

/** Group consecutive thinking entries, closing the active group at every visible conversation entry. */
export function groupThinkingEntries(entries: readonly ClassifiedConversationEntry[]): ThinkingGroup[] {
	const groups: ThinkingGroup[] = [];
	for (const entry of entries) {
		if (entry.kind === "tool-log-only") continue;
		if (entry.kind === "other") {
			const open = groups.at(-1);
			if (open?.state === "open") open.state = "closed";
			continue;
		}
		const sections = entry.sections.filter((section) => section.trim().length > 0);
		if (sections.length === 0) continue;
		const open = groups.at(-1);
		if (open?.state === "open") open.sections.push(...sections);
		else groups.push({ sections: [...sections], state: "open" });
	}
	return groups;
}

/** Incrementally tracks the current thinking group using the same classification rules as replay. */
export class ConversationThinkingTracker {
	private entries: ClassifiedConversationEntry[] = [];
	private groups: ThinkingGroup[] = [];

	/** Record one conversation append; tool-log-only entries do not close a group. */
	noteEntry(entry: ClassifiedConversationEntry): ThinkingGroup | undefined {
		const previouslyOpen = this.groups.at(-1)?.state === "open" ? this.groups.at(-1) : undefined;
		this.entries.push(entry);
		if (entry.kind === "tool-log-only") return undefined;
		const nextGroups = groupThinkingEntries(this.entries);
		for (let index = 0; index < nextGroups.length; index++) {
			const nextGroup = nextGroups[index];
			const existingGroup = this.groups[index];
			if (existingGroup) {
				existingGroup.sections.splice(0, existingGroup.sections.length, ...nextGroup.sections);
				existingGroup.state = nextGroup.state;
			} else {
				this.groups.push(nextGroup);
			}
		}
		this.groups.length = nextGroups.length;
		if (entry.kind === "other") return previouslyOpen;
		if (entry.sections.every((section) => !section.trim())) return undefined;
		return this.groups.at(-1);
	}

	/** Replace the open group's latest section while its assistant message is streaming. */
	updateLatestSection(section: string): ThinkingGroup | undefined {
		const open = this.groups.at(-1);
		if (open?.state !== "open" || open.sections.length === 0) return undefined;
		if (section.trim()) {
			open.sections[open.sections.length - 1] = section.trim();
			const latestEntry = this.entries.at(-1);
			if (latestEntry?.kind === "thinking") {
				this.entries[this.entries.length - 1] = { kind: "thinking", sections: [section.trim()] };
			}
		}
		return open;
	}

	/** Return the current group projection for a transcript rebuild. */
	getGroups(): ThinkingGroup[] {
		return this.groups;
	}

	/** Reset state before replaying an ordered conversation. */
	clear(): void {
		this.entries = [];
		this.groups = [];
	}
}
