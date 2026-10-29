import { requireNativeModule } from 'expo'
export interface InspectedLibraryBackup {
	token: string
	catalogueJson: string
	full: boolean
	audioFiles: number
	themeFiles: number
	coverFiles: number
	bytes: number
}
export interface LibraryBackupNativeModule {
	exportAsync(catalogueJson: string, full: boolean): Promise<string>
	/** Opens system create-document picker; true only after copying verified source bytes and closing provider output. */
	saveAsync(catalogueJson: string, full: boolean): Promise<boolean>
	inspectAsync(uri: string): Promise<InspectedLibraryBackup>
	/** Only adds missing files; compares hashes and rejects same-path/different-content collisions. */
	publishFilesAsync(token: string): Promise<void>
	discardAsync(token: string): Promise<void>
}
export const getLibraryBackupModule = (): LibraryBackupNativeModule =>
	requireNativeModule<LibraryBackupNativeModule>('MeloLibraryBackup')
