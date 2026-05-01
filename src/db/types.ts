export interface DailyActivity {
	id?: number;
	date: string;
	filePath: string;
	wordCountStart: number;
	charCountStart: number;
	changes: TimeEntry[];
}

export interface TimeEntry {
	timeKey: string;
	w: number;
	c: number;
	sources?: Record<string, TimeEntrySource>;
}

export interface TimeEntrySource {
	w: number;
	c: number;
}
