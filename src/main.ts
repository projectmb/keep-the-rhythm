import { formatDate } from "./utils/dateUtils";
import { moment as _moment } from "obsidian";
const moment = _moment as unknown as typeof _moment.default;
import {
	Plugin,
	TFile,
	TAbstractFile,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	Notice,
} from "obsidian";
import React from "react";
import { createRoot } from "react-dom/client";

import {
	ColorConfig,
	DEFAULT_SETTINGS,
	STARTING_STATS,
	PluginData,
} from "@/defs/types";

import { getDB, initDatabase } from "@/db/db";
import { EVENTS, state } from "@/core/pluginState";
import { PluginView, VIEW_TYPE } from "@/ui/views/PluginView";

import { SettingsTab } from "@/ui/views/SettingsTab";
import { SlotWrapper } from "./ui/components/SlotWrapper";
import { Heatmap } from "@/ui/components/Heatmap";
import { Entries } from "./ui/components/Entries";

import { migrateDataFromOldFormat } from "./utils/migrateData";
import { parseQueryToJSEP, parseSlotQuery } from "./core/codeBlockQuery";
import * as utils from "@/utils/utils";
import * as events from "@/core/events";
import {
	getLocalDeviceId,
	mergeDailyActivities,
	normalizeDailyActivities,
	stripRuntimeFields,
} from "@/utils/activityMerge";

export default class KeepTheRhythm extends Plugin {
	data: PluginData = {
		schema: "0.2",
		settings: DEFAULT_SETTINGS,
		stats: {
			dailyActivity: [],
		},
	};
	codeBlockRoots: Map<
		HTMLElement,
		{ root: any; ctx: MarkdownPostProcessorContext; source: string }
	> = new Map();
	private JSON_DEBOUNCE_TIME = 1000;
	private JsonDebounceTimeout: any = null;
	private externalDataMergeInterval: number | null = null;
	private isMergingExternalData = false;
	private backupFolderPath = ".keep-the-rhythm";
	private syncFolderPath = "Keep The Rhythm";
	private syncDataPath = "Keep The Rhythm/data.json";
	private deviceSyncFolderPath = "Keep The Rhythm/devices";

	private get deviceSyncDataPath() {
		const deviceId = getLocalDeviceId(this.app.vault.getName());
		return `${this.deviceSyncFolderPath}/${deviceId}.json`;
	}

	// #region Initialization
	async onload() {
		// #region JSON

		state.setPlugin(this);

		initDatabase();
		getDB().dailyActivity.clear(); // restarts DB to ensure data.json is the source of truth
		const pluginData = (await this.loadData()) as PluginData | null;
		const vaultSyncData = await this.readVaultSyncData();
		const loadedData = this.mergePluginData(pluginData, vaultSyncData);

		let lastBreakingChangeToSchema = "0.2";
		let shouldSaveInitialData = false;

		if (loadedData) {
			await this.backupDataToVaultFolder(loadedData);
		}

		/** Data is only loaded into dexie if it's the correct schema */
		if (loadedData && loadedData.schema == lastBreakingChangeToSchema) {
			await this.initializeDataFromJSON(loadedData);
		} else if (
			loadedData &&
			loadedData.schema !== lastBreakingChangeToSchema
		) {
			new Notice("KTR: Migrating data from previous versions...");
			await this.migrateDataFromJSON(loadedData);
			shouldSaveInitialData = true;
		} else if (!loadedData) {
			this.data.schema = lastBreakingChangeToSchema;
			this.data.stats = {
				...STARTING_STATS,
			};
			shouldSaveInitialData = true;
		} else {
			this.data.stats = loadedData.stats;
			this.data.settings = loadedData.settings;
		}

		if (shouldSaveInitialData) {
			await this.saveData(this.data);
			await this.writeVaultSyncData(this.data);
		}

		// #endregion

		state.setToday();

		this.checkVaultCountStaleness();

		// /** Set of utility functions that registers required objects and sets plugin state */

		/** Initialize SIDEBAR view */
		this.registerView(VIEW_TYPE, (leaf) => {
			return new PluginView(leaf, this);
		});

		this.initializeCommands();
		this.initializeEvents();
		this.applyColorStyles();
		this.addSettingTab(new SettingsTab(this.app, this));

		/** Registers CUSTOM CODE BLOCKS */
		this.registerMarkdownCodeBlockProcessor(
			"ktr-heatmap",
			this.createHeatmapCodeBlock(),
		);

		this.registerMarkdownCodeBlockProcessor(
			"ktr-slots",
			this.createSlotsCodeBlock(),
		);

		this.registerMarkdownCodeBlockProcessor(
			"ktr-entries",
			this.createEntriesCodeBlock(),
		);

		this.externalDataMergeInterval = window.setInterval(async () => {
			const didMerge = await this.mergeExternalDataFromJSON();
			if (didMerge) {
				await this.saveData(this.data);
				state.emit(EVENTS.REFRESH_EVERYTHING);
			}
		}, 10000);
	}

	private async checkVaultCountStaleness() {
		if (
			this.data.stats?.wholeVaultWordCount !== undefined &&
			this.data.stats?.wholeVaultCharCount !== undefined
		) {
			const recentActivity = await getDB()
				.dailyActivity.orderBy("date")
				.reverse()
				.first();

			if (recentActivity) {
				const daysSinceLastActivity = moment().diff(
					moment(recentActivity.date),
					"days",
				);
				if (daysSinceLastActivity > 7) {
					this.data.stats.wholeVaultWordCount = undefined;
					this.data.stats.wholeVaultCharCount = undefined;
					await this.saveData(this.data);
				}
			}
		}
	}

	private async backupDataToVaultFolder(data: any) {
		const folderPath = this.backupFolderPath;
		const typoOlderPath = ".keep-the-rhyhtm"; // there's a typo here and unfortuntely it will haunt me forever
		const fileName = `backup-${formatDate(new Date())}-${data.schema}.json`;
		const backupPath = `${folderPath}/${fileName}`;
		const jsonData = JSON.stringify(data, null, 2);

		const oldFolderExists =
			await this.app.vault.adapter.exists(typoOlderPath);

		if (oldFolderExists) {
			const correctFolderExists =
				await this.app.vault.adapter.exists(folderPath);
			if (!correctFolderExists) {
				await this.app.vault.adapter.mkdir(folderPath);
			}

			const oldFolderFiles =
				await this.app.vault.adapter.list(typoOlderPath);
			for (const filePath of oldFolderFiles.files) {
				const fileName = filePath.split("/").pop();
				if (!fileName) continue;

				const newPath = `${folderPath}/${fileName}`;
				await this.app.vault.adapter.rename(filePath, newPath);
				console.log(`Moved backup file to correct folder: ${fileName}`);
			}

			const remaining = await this.app.vault.adapter.list(typoOlderPath);
			if (
				remaining.files.length === 0 &&
				remaining.folders.length === 0
			) {
				await this.app.vault.adapter.rmdir(typoOlderPath, true);
				console.log("Removed old backup folder: .keep-the-rhyhtm");
			}
		}
		const folderExists = await this.app.vault.adapter.exists(folderPath);

		if (!folderExists) {
			await this.app.vault.adapter.mkdir(folderPath);
		}

		const filesOnBackupsFolder =
			await this.app.vault.adapter.list(folderPath);
		const backupFiles = filesOnBackupsFolder.files.filter((f) =>
			/\/backup-\d{4}-\d{2}-\d{2}(?:-[\w\d.]+)?\.json$/.test(f),
		);

		// only cleans backups if we have more than 3, which should avoid losing stuff even if its older
		if (backupFiles.length > 3) {
			await this.cleanOlderBackups(backupFiles);
		}

		// This if runs if the user has data from previous schemas, checking
		// every backup to see if the data was already backed up and saving it otherwise.
		if (data.schema !== "0.3") {
			// Compare against all existing backups
			for (const filePath of backupFiles) {
				try {
					if (!(await this.app.vault.adapter.exists(filePath))) {
						console.error("File does not exist:", filePath);
						return;
					}
					const contents =
						await this.app.vault.adapter.read(filePath);
					if (contents && contents === jsonData) {
						new Notice("KTR: No changes to backup.");
						return;
					}
				} catch (err) {
					console.error("Failed to read file:", filePath, err);
					return null;
				}
			}
			// No identical backup found, save new one
			await this.app.vault.adapter.write(backupPath, jsonData);
			new Notice("KTR: New backup saved.");
		} else {
			await this.app.vault.adapter.write(backupPath, jsonData);
			new Notice("KTR: First backup created.");
		}
	}

	private async cleanOlderBackups(backupPaths: string[]) {
		const now = window.moment();

		for (const fullPath of backupPaths) {
			// Check if file still exists before doing anything
			const fileExists = await this.app.vault.adapter.exists(fullPath);
			if (!fileExists) {
				console.warn(`File already missing: ${fullPath}`);
				continue;
			}

			const fileName = fullPath.split("/").pop();
			if (!fileName) continue;

			// Match: backup-YYYY-MM-DD(-optionalSchema).json
			const match = fileName.match(
				/^backup-(\d{4}-\d{2}-\d{2})(?:-[\w\d.]+)?\.json$/,
			);
			if (!match) continue;

			const dateStr = match[1];
			const fileDate = window.moment(dateStr, "YYYY-MM-DD", true);

			if (!fileDate.isValid()) {
				console.warn(`Skipping file with invalid date: ${fileName}`);
				continue;
			}

			const ageInDays = now.diff(fileDate, "days");

			if (ageInDays > 14) {
				await this.app.vault.adapter.remove(fullPath);
				console.log(`Deleted old backup: ${fileName}`);
			}
		}
	}

	private async migrateDataFromJSON(loadedData: any) {
		const previousStats = migrateDataFromOldFormat(loadedData);
		this.data.stats = previousStats.stats;
		this.data.schema = "0.2";

		if (this.data.stats) {
			await getDB().dailyActivity.bulkAdd(this.data.stats.dailyActivity);
		}
	}

	private async initializeDataFromJSON(loadedData: PluginData) {
		if (loadedData.settings) {
			this.data.settings = {
				...DEFAULT_SETTINGS,
				...loadedData.settings,
			};
		}
		if (loadedData.stats) {
			this.data.stats = loadedData.stats;
			await this.checkPreviousStreak();

			const dailyActivitiesFromJSON = normalizeDailyActivities(
				this.data.stats?.dailyActivity || [],
			);
			this.data.stats.dailyActivity = dailyActivitiesFromJSON;

			try {
				await getDB().dailyActivity.bulkAdd(dailyActivitiesFromJSON);
			} catch (error) {
				console.error(
					"Failed loading some data, contact the developer.",
					error,
				);
			}
		}
	}

	private applyColorStyles() {
		const containerStyle = this.app.workspace.containerEl.style;
		let light = undefined;
		let dark = undefined;

		if (this.data.settings?.heatmapConfig?.colors) {
			light = this.data.settings.heatmapConfig.colors?.light;
			dark = this.data.settings.heatmapConfig.colors?.dark;
		}

		if (light && dark) {
			for (let i = 0; i <= 4; i++) {
				const key = i as keyof ColorConfig;
				containerStyle.setProperty(`--light-${i}`, light[key]);
				containerStyle.setProperty(`--dark-${i}`, dark[key]);
			}
		}
	}

	private createEntriesCodeBlock(): (
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	) => void {
		return (
			source: string,
			el: HTMLElement,
			ctx: MarkdownPostProcessorContext,
		) => {
			if (!this.data || !this.data.settings) {
				return;
			}

			const container = el.createDiv("slots-codeblock");
			const root = createRoot(container);
			this.codeBlockRoots.set(el, { root, ctx, source });

			let date;
			const trimmedSource = source.trim();
			
			if (trimmedSource !== "") {
				// Check if source contains template variable like {{date:YYYY-MM-DD}}
				const templateRegex = /\{\{date:([^}]+)\}\}/;
				const match = trimmedSource.match(templateRegex);
				
				if (match) {
					// Extract the format from the template (e.g., "YYYY-MM-DD")
					const format = match[1];
					
					// Get the file where this code block is embedded (from context)
					const contextFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
					
					if (contextFile && contextFile instanceof TFile) {
						// Try to parse date from filename using common patterns
						const fileName = contextFile.basename;
						
						// Try to match YYYY-MM-DD pattern in filename
						const dateMatch = fileName.match(/(\d{4})-(\d{2})-(\d{2})/);
						
						if (dateMatch) {
							// Found date in filename, format it according to the template
							date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
						} else {
							// Fallback to today's date if no date found in filename
							date = moment().format(format);
						}
					} else {
						// No file found, use today's date
						date = moment().format(format);
					}
				} else {
					// No template variable, use the source as-is (hardcoded date)
					date = trimmedSource;
				}
			}

			root.render(
				React.createElement(Entries, {
					date: date,
				}),
			);

			return;
		};
	}

	private createSlotsCodeBlock(): (
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	) => void {
		return (
			source: string,
			el: HTMLElement,
			ctx: MarkdownPostProcessorContext,
		) => {
			if (!this.data || !this.data.settings) {
				return;
			}

			const config = parseSlotQuery(source);
			if (config.length === 0) return;

			const container = el.createDiv("slots-codeblock");
			const root = createRoot(container);
			this.codeBlockRoots.set(el, { root, ctx, source });

			root.render(
				React.createElement(SlotWrapper, {
					slots: config,
					isCodeBlock: true,
				}),
			);

			// ctx.addChild(
			// 	new (class extends MarkdownRenderChild {
			// 		constructor(containerEl: HTMLElement) {
			// 			super(containerEl);
			// 		}
			// 		onunload() {
			// 			root.unmount();
			// 		}
			// 	})(container),
			// );
			return;
		};
	}

	private createHeatmapCodeBlock(): (
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	) => void {
		return (
			source: string,
			el: HTMLElement,
			ctx: MarkdownPostProcessorContext,
		) => {
			if (!this.data || !this.data.settings) {
				return;
			}

			// if (source.trim() !== "") return

			const query = parseQueryToJSEP(source.trim());
			if (!query?.options) return;

			const container = el.createDiv("heatmap-codeblock");
			const root = createRoot(container);
			this.codeBlockRoots.set(el, { root, ctx, source });

			root.render(
				React.createElement(Heatmap, {
					heatmapConfig: query?.options,
					query: query?.filter,
					isCodeBlock: true,
					amountOfWeeks: query?.options.numberOfWeeks,
				}),
			);

			ctx.addChild(
				new (class extends MarkdownRenderChild {
					constructor(containerEl: HTMLElement) {
						super(containerEl);
					}
					onunload() {
						root.unmount();
					}
				})(container),
			);
			return;
		};
	}

	private initializeCommands() {
		this.addRibbonIcon("calendar-days", "Word Count Stats", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-keep-the-rhythm",
			name: "Open sidebar view",
			callback: () => {
				this.activateView();
			},
		});

		this.addCommand({
			id: "check-ktr-streak",
			name: "Check writing goal from previous days",
			callback: () => {
				this.checkPreviousStreak();
			},
		});

		this.addCommand({
			id: "ktr-export-sync-data",
			name: "Export stats to vault sync file",
			callback: async () => {
				await this.saveDataToJSON();
				new Notice("KTR: Exported stats to Keep The Rhythm/data.json");
			},
		});

		this.addCommand({
			id: "ktr-import-sync-data",
			name: "Import stats from vault sync file",
			callback: async () => {
				const didMerge = await this.mergeExternalDataFromJSON();
				await this.saveData(this.data);
				await this.writeVaultSyncData(this.data);
				state.emit(EVENTS.REFRESH_EVERYTHING);
				new Notice(
					didMerge
						? "KTR: Imported stats from Keep The Rhythm/data.json"
						: "KTR: Sync file already matches local stats",
				);
			},
		});
	}

	private async checkPreviousStreak() {
		if (!this.data.settings) return;

		const activities = await getDB().dailyActivity.toArray();

		for (let i = 0; i < activities.length; i++) {
			const { totalWords } = utils.sumBothTimeEntries(activities[i]);
			if (
				totalWords > this.data.settings.dailyWritingGoal &&
				!this.data.stats?.daysWithCompletedGoal?.includes(
					activities[i].date,
				)
			) {
				this.data.stats?.daysWithCompletedGoal?.push(
					activities[i].date,
				);
			}
		}
	}

	private initializeEvents() {
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, info) => {
				events.handleEditorChange(editor, info, this);
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile) events.handleFileCreate(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on(
				"rename",
				(file: TAbstractFile, oldPath: string) => {
					if (file instanceof TFile)
						events.handleFileRename(file, oldPath);
				},
			),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) events.handleFileOpen(file);
			}),
		);
	}

	// #endregion

	// #region Unloading

	async onunload() {
		await events.cleanDBTimeout();

		if (this.JsonDebounceTimeout) {
			clearTimeout(this.JsonDebounceTimeout);
		}
		if (this.externalDataMergeInterval !== null) {
			window.clearInterval(this.externalDataMergeInterval);
		}
		await this.saveDataToJSON();
		await this.backupDataToVaultFolder(this.data);

		await getDB().dailyActivity.clear();
	}

	// #endregion

	async onExternalSettingsChange() {
		try {
			if (await this.mergeExternalDataFromJSON()) {
				await this.saveData(this.data);
				await this.writeVaultSyncData(this.data);
				state.emit(EVENTS.REFRESH_EVERYTHING);
			}
		} catch (error) {
			console.error("Error in onExternalSettingsChange:", error);
		}
	}

	// #region SAVING DATA

	private mergePluginData(
		primary: PluginData | null | undefined,
		secondary: PluginData | null | undefined,
	): PluginData | null {
		if (!primary && !secondary) return null;
		if (!primary) return secondary as PluginData;
		if (!secondary) return primary;

		const daysWithCompletedGoal = Array.from(
			new Set([
				...(primary.stats?.daysWithCompletedGoal || []),
				...(secondary.stats?.daysWithCompletedGoal || []),
			]),
		).sort();

		return {
			...primary,
			...secondary,
			schema: secondary.schema || primary.schema,
			settings: {
				...DEFAULT_SETTINGS,
				...(primary.settings || {}),
				...(secondary.settings || {}),
			},
			stats: {
				...primary.stats,
				...secondary.stats,
				daysWithCompletedGoal,
				dailyActivity: normalizeDailyActivities([
					...(primary.stats?.dailyActivity || []),
					...(secondary.stats?.dailyActivity || []),
				]),
			},
		};
	}

	private mergePluginDataList(dataList: PluginData[]): PluginData | null {
		return dataList.reduce<PluginData | null>(
			(merged, data) => this.mergePluginData(merged, data),
			null,
		);
	}

	private async ensureSyncFolder() {
		const folderExists = await this.app.vault.adapter.exists(
			this.syncFolderPath,
		);
		if (!folderExists) {
			await this.app.vault.adapter.mkdir(this.syncFolderPath);
		}

		const deviceFolderExists = await this.app.vault.adapter.exists(
			this.deviceSyncFolderPath,
		);
		if (!deviceFolderExists) {
			await this.app.vault.adapter.mkdir(this.deviceSyncFolderPath);
		}
	}

	private async readVaultSyncData(): Promise<PluginData | null> {
		const dataSources: PluginData[] = [];

		try {
			const exists = await this.app.vault.adapter.exists(
				this.syncDataPath,
			);
			if (exists) {
				const contents = await this.app.vault.adapter.read(
					this.syncDataPath,
				);
				if (contents) {
					dataSources.push(JSON.parse(contents) as PluginData);
				}
			}

			const deviceFolderExists = await this.app.vault.adapter.exists(
				this.deviceSyncFolderPath,
			);
			if (deviceFolderExists) {
				const deviceFiles = await this.app.vault.adapter.list(
					this.deviceSyncFolderPath,
				);
				for (const filePath of deviceFiles.files) {
					if (!filePath.endsWith(".json")) continue;

					try {
						const contents =
							await this.app.vault.adapter.read(filePath);
						if (contents) {
							dataSources.push(
								JSON.parse(contents) as PluginData,
							);
						}
					} catch (error) {
						console.error(
							`Error reading KTR device sync data: ${filePath}`,
							error,
						);
					}
				}
			}

			return this.mergePluginDataList(dataSources);
		} catch (error) {
			console.error("Error reading KTR vault sync data:", error);
			return null;
		}
	}

	private async writeVaultSyncData(data: PluginData) {
		await this.ensureSyncFolder();
		const dataToSync: PluginData = {
			...data,
			stats: {
				...data.stats,
				dailyActivity: normalizeDailyActivities(
					(data.stats?.dailyActivity || []).map(stripRuntimeFields),
				),
			},
		};

		await this.app.vault.adapter.write(
			this.deviceSyncDataPath,
			JSON.stringify(dataToSync, null, 2),
		);

		// Compatibility snapshot for inspection and existing installs. The
		// authoritative sync source is the per-device files in /devices.
		await this.app.vault.adapter.write(
			this.syncDataPath,
			JSON.stringify(dataToSync, null, 2),
		);
	}

	private async mergeExternalDataFromJSON(): Promise<boolean> {
		if (this.isMergingExternalData) return false;

		this.isMergingExternalData = true;
		try {
			const pluginData = (await this.loadData()) as PluginData | null;
			const vaultSyncData = await this.readVaultSyncData();
			const newData = this.mergePluginData(pluginData, vaultSyncData);
			if (!newData?.stats?.dailyActivity) return false;

			const incomingActivities = normalizeDailyActivities(
				newData.stats.dailyActivity,
			);
			let didMerge = false;

			for (const incomingActivity of incomingActivities) {
				const existingActivity = await getDB()
					.dailyActivity.where("[date+filePath]")
					.equals([
						incomingActivity.date,
						incomingActivity.filePath,
					])
					.first();

				if (existingActivity) {
					const mergedActivity = mergeDailyActivities(
						existingActivity,
						incomingActivity,
					);
					if (
						JSON.stringify(stripRuntimeFields(existingActivity)) !==
						JSON.stringify(stripRuntimeFields(mergedActivity))
					) {
						await getDB().dailyActivity.put(mergedActivity);
						didMerge = true;
					}
				} else {
					await getDB().dailyActivity.add(incomingActivity);
					didMerge = true;
				}
			}

			const daysWithCompletedGoal = Array.from(
				new Set([
					...(this.data.stats?.daysWithCompletedGoal || []),
					...(newData.stats.daysWithCompletedGoal || []),
				]),
			).sort();

			if (
				JSON.stringify(daysWithCompletedGoal) !==
				JSON.stringify(this.data.stats?.daysWithCompletedGoal || [])
			) {
				didMerge = true;
			}

			this.data.settings = {
				...DEFAULT_SETTINGS,
				...(this.data.settings || {}),
				...(newData.settings || {}),
			};

			this.data.stats = {
				...this.data.stats,
				...newData.stats,
				daysWithCompletedGoal,
				dailyActivity: normalizeDailyActivities(
					(await getDB().dailyActivity.toArray()).map(
						stripRuntimeFields,
					),
				),
			};

			return didMerge;
		} catch (error) {
			console.error("Error merging external KTR data:", error);
			return false;
		} finally {
			this.isMergingExternalData = false;
		}
	}

	public async saveDataToJSON() {
		await this.mergeExternalDataFromJSON();
		const dailyActivityDB = await getDB().dailyActivity.toArray();

		this.data.stats = {
			...this.data.stats,
			dailyActivity: normalizeDailyActivities(
				dailyActivityDB.map(stripRuntimeFields),
			),
		};

		await this.saveData(this.data);
		await this.writeVaultSyncData(this.data);
	}

	public async updateCurrentStreak(increase: boolean) {
		if (!this.data.stats) return;

		// TODO: check previous date to see when was the last one

		if (!this.data.stats.daysWithCompletedGoal) {
			this.data.stats.daysWithCompletedGoal = [];
		}

		const { longestStreak, currentStreak } = utils.getDateStreaks(
			this.data.stats.daysWithCompletedGoal,
		);

		if (increase) {
			if (this.data.stats.daysWithCompletedGoal.includes(state.today)) {
				return;
			}
			this.data.stats.daysWithCompletedGoal.push(state.today);
		} else {
			if (this.data.stats.daysWithCompletedGoal.includes(state.today)) {
				const newArray = this.data.stats.daysWithCompletedGoal?.filter(
					(item) => item !== state.today,
				);
				this.data.stats.daysWithCompletedGoal = newArray;
			}
		}
		await this.quietSave();
	}

	public async updateAndSaveEverything() {
		await this.saveData(this.data);
		await this.writeVaultSyncData(this.data);
		state.emit(EVENTS.REFRESH_EVERYTHING);
	}

	public async quietSave() {
		await this.saveData(this.data);
		await this.writeVaultSyncData(this.data);
	}

	// #endregion

	/**
	 * @function activateView opens the SIDEBAR plugin view
	 */
	async activateView() {
		// Return if view already exists
		if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0) return;

		// Get the leaf and focus on it
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: VIEW_TYPE,
				active: true,
			});
		}
	}
}
