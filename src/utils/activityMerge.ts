import { DailyActivity, TimeEntry, TimeEntrySource } from "@/db/types";

const DEVICE_ID_KEY_PREFIX = "keep-the-rhythm-device-id";
const LEGACY_SOURCE_PREFIX = "legacy";

function cloneTimeEntry(entry: TimeEntry): TimeEntry {
	return {
		timeKey: entry.timeKey,
		w: entry.w || 0,
		c: entry.c || 0,
		sources: entry.sources ? { ...entry.sources } : undefined,
	};
}

function sumSources(sources: Record<string, TimeEntrySource>) {
	return Object.values(sources).reduce(
		(total, source) => ({
			w: total.w + (source.w || 0),
			c: total.c + (source.c || 0),
		}),
		{ w: 0, c: 0 },
	);
}

function legacySourceKey(entry: TimeEntry) {
	return `${LEGACY_SOURCE_PREFIX}:${entry.timeKey}:${entry.w || 0}:${entry.c || 0}`;
}

function addEntryToSources(
	sources: Record<string, TimeEntrySource>,
	entry: TimeEntry,
) {
	if (entry.sources) {
		for (const [sourceId, source] of Object.entries(entry.sources)) {
			const existing = sources[sourceId];
			sources[sourceId] = {
				w: Math.max(existing?.w || 0, source.w || 0),
				c: Math.max(existing?.c || 0, source.c || 0),
			};
		}
		return;
	}

	sources[legacySourceKey(entry)] = {
		w: entry.w || 0,
		c: entry.c || 0,
	};
}

function sourceTotal(entry: TimeEntry) {
	return entry.sources ? sumSources(entry.sources) : null;
}

export function getLocalDeviceId(vaultName: string) {
	const key = `${DEVICE_ID_KEY_PREFIX}:${vaultName}`;
	const existing = window.localStorage.getItem(key);
	if (existing) return existing;

	const randomId =
		window.crypto?.randomUUID?.() ||
		`${Date.now()}-${Math.random().toString(36).slice(2)}`;
	window.localStorage.setItem(key, randomId);
	return randomId;
}

export function addDeltaToTimeEntry(
	entry: TimeEntry,
	wordsDelta: number,
	charsDelta: number,
	deviceId: string,
) {
	if (!entry.sources) {
		entry.sources = {};
		if (entry.w || entry.c) {
			entry.sources[legacySourceKey(entry)] = {
				w: entry.w || 0,
				c: entry.c || 0,
			};
		}
	}

	const source = entry.sources[deviceId] || { w: 0, c: 0 };
	entry.sources[deviceId] = {
		w: source.w + wordsDelta,
		c: source.c + charsDelta,
	};

	const total = sumSources(entry.sources);
	entry.w = total.w;
	entry.c = total.c;
}

export function mergeTimeEntries(
	left: TimeEntry,
	right: TimeEntry,
): TimeEntry {
	if (!left.sources && !right.sources) {
		return {
			timeKey: left.timeKey,
			w: Math.max(left.w || 0, right.w || 0),
			c: Math.max(left.c || 0, right.c || 0),
		};
	}

	const leftSourceTotal = sourceTotal(left);
	const rightSourceTotal = sourceTotal(right);
	if (
		leftSourceTotal &&
		!right.sources &&
		leftSourceTotal.w === (right.w || 0) &&
		leftSourceTotal.c === (right.c || 0)
	) {
		return { ...left, sources: { ...left.sources } };
	}
	if (
		rightSourceTotal &&
		!left.sources &&
		rightSourceTotal.w === (left.w || 0) &&
		rightSourceTotal.c === (left.c || 0)
	) {
		return { ...right, sources: { ...right.sources } };
	}

	const sources: Record<string, TimeEntrySource> = {};
	addEntryToSources(sources, left);
	addEntryToSources(sources, right);

	const total = sumSources(sources);
	return {
		timeKey: left.timeKey,
		w: total.w,
		c: total.c,
		sources,
	};
}

export function normalizeTimeEntries(entries: TimeEntry[] = []) {
	const entriesByTime = new Map<string, TimeEntry>();

	for (const entry of entries) {
		const normalized = cloneTimeEntry(entry);
		const existing = entriesByTime.get(normalized.timeKey);
		entriesByTime.set(
			normalized.timeKey,
			existing ? mergeTimeEntries(existing, normalized) : normalized,
		);
	}

	return Array.from(entriesByTime.values()).sort((a, b) =>
		a.timeKey.localeCompare(b.timeKey),
	);
}

export function mergeDailyActivities(
	left: DailyActivity,
	right: DailyActivity,
): DailyActivity {
	const merged: DailyActivity = {
		...left,
		id: left.id,
		date: left.date || right.date,
		filePath: left.filePath || right.filePath,
		wordCountStart: Math.min(
			left.wordCountStart || 0,
			right.wordCountStart || 0,
		),
		charCountStart: Math.min(
			left.charCountStart || 0,
			right.charCountStart || 0,
		),
		changes: normalizeTimeEntries([
			...(left.changes || []),
			...(right.changes || []),
		]),
	};

	return merged;
}

export function normalizeDailyActivities(activities: DailyActivity[] = []) {
	const activitiesByKey = new Map<string, DailyActivity>();

	for (const activity of activities) {
		const activityWithoutId = stripRuntimeFields(activity);
		const key = `${activityWithoutId.date}\u0000${activityWithoutId.filePath}`;
		const existing = activitiesByKey.get(key);
		activitiesByKey.set(
			key,
			existing
				? mergeDailyActivities(existing, activityWithoutId)
				: activityWithoutId,
		);
	}

	return Array.from(activitiesByKey.values());
}

export function stripRuntimeFields(activity: DailyActivity): DailyActivity {
	return {
		date: activity.date,
		filePath: activity.filePath,
		wordCountStart: activity.wordCountStart || 0,
		charCountStart: activity.charCountStart || 0,
		changes: normalizeTimeEntries(activity.changes || []),
	};
}
