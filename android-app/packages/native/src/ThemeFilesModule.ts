import { requireNativeModule } from 'expo'

export interface ThemeFilesNativeModule {
	rootAsync(): Promise<string>
	createStageAsync(): Promise<{ token: string; privateRootUri: string }>
	writeStageAsync(token: string, path: string, bytes: Uint8Array): Promise<void>
	readAsync(scope: string, path: string, maxBytes: number): Promise<Uint8Array>
	listAsync(
		scope: string,
		path: string,
	): Promise<{ path: string; bytes: number }[]>
	publishAsync(
		token: string,
		id: string,
		hash: string,
	): Promise<'created' | 'exists'>
	removeStageAsync(token: string): Promise<void>
	readVerifiedAsync?(id: string, hash: string, context: string): Promise<string | null>
	writeVerifiedAsync?(id: string, hash: string, context: string, payload: string,
		entries: { path: string; bytes: number; sha256: string }[]): Promise<void>
	removeInstalledAsync?(id: string, hash: string, token: string): Promise<void>
	readSelectedAsync(uri: string): Promise<Uint8Array>
}

export const getThemeFilesModule = (): ThemeFilesNativeModule =>
	requireNativeModule<ThemeFilesNativeModule>('MeloThemeFiles')
