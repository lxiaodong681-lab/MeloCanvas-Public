import type { ExpoConfig } from 'expo/config'

const config: ExpoConfig = {
	name: '音绘',
	slug: 'melocanvas',
	version: '0.19.4',
	orientation: 'portrait',
	icon: './melo/assets/icon.png',
	scheme: 'melocanvas',
	platforms: ['android'],
	userInterfaceStyle: 'automatic',
	updates: { enabled: false },
	android: {
		package: 'org.melocanvas.app',
		versionCode: 35,
		permissions: ['POST_NOTIFICATIONS'],
		blockedPermissions: [
			'android.permission.REQUEST_INSTALL_PACKAGES',
			'android.permission.RECORD_AUDIO',
			'android.permission.SYSTEM_ALERT_WINDOW',
			'android.permission.READ_MEDIA_AUDIO',
			'android.permission.READ_MEDIA_IMAGES',
			'android.permission.READ_MEDIA_VIDEO',
			'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
			'android.permission.READ_EXTERNAL_STORAGE',
			'android.permission.WRITE_EXTERNAL_STORAGE',
			'android.permission.ACCESS_MEDIA_LOCATION',
			'com.google.android.gms.permission.AD_ID',
		],
		adaptiveIcon: {
			foregroundImage: './melo/assets/icon-foreground.png',
			backgroundColor: '#faf8f5',
		},
	},
	plugins: [
		'./expo-plugins/withKotlinSerialization',
		'./expo-plugins/withAndroidGradleProperties',
		[
			'./expo-plugins/withAbiFilters',
			{
				abiFilters: (process.env.ABI_FILTERS || 'arm64-v8a,x86_64').split(','),
			},
		],
		[
			'expo-build-properties',
			{
				android: {
					minSdkVersion: 26,
					usesCleartextTraffic: false,
					enableMinifyInReleaseBuilds: false,
					packagingOptions: { pickFirst: ['lib/*/libNitroModules.so'] },
				},
			},
		],
		'expo-asset',
		'expo-font',
		'expo-image',
		'expo-sqlite',
		'./expo-plugins/withMeloAndroid',
		'./expo-plugins/withMeloSplash',
	],
}

export default config
