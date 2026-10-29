const {
	AndroidConfig,
	withAndroidManifest,
	withAppBuildGradle,
	withMainActivity,
} = require('expo/config-plugins')

const fontScaleImports = [
	'android.content.res.Configuration',
	'com.facebook.react.ReactApplication',
	'com.facebook.react.bridge.LifecycleEventListener',
]
const fontScaleRefresh = `  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // RN refreshes its cached font scale on resume; an active config change
    // also needs that existing DeviceInfo refresh so JS can remeasure text.
    val context = (application as ReactApplication).reactHost?.currentReactContext
    val deviceInfo = context?.getNativeModule("DeviceInfo")
    if (deviceInfo is LifecycleEventListener) deviceInfo.onHostResume()
  }`

function refreshFontScale(contents) {
	// Locate declarations without mistaking strings/comments for Kotlin braces or hooks.
	const code = contents.replace(
		/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
		(value) => value.replace(/[^\r\n]/g, ' '),
	)
	const classes = [
		...code.matchAll(
			/\bclass\s+MainActivity\s*:\s*ReactActivity\s*\(\s*\)\s*\{/g,
		),
	]
	if (
		classes.length !== 1 ||
		!/^[\t ]*package\s+[\w.]+[\t ]*;?[\t ]*\r?$/m.test(code)
	)
		throw new Error(
			'Melo font-scale generation requires one Kotlin MainActivity and package declaration',
		)
	const opening = classes[0].index + classes[0][0].lastIndexOf('{')
	function closingBrace(start) {
		let depth = 0
		for (let index = start; index < code.length; index++) {
			if (code[index] === '{') depth++
			if (code[index] === '}' && --depth === 0) return index
		}
		throw new Error(
			'Melo font-scale generation found an incomplete MainActivity block',
		)
	}
	const closing = closingBrace(opening)
	const hooks = [...code.matchAll(/\bfun\s+onConfigurationChanged\s*\(/g)]
	if (hooks.length > 1)
		throw new Error(
			'Melo font-scale generation found duplicate onConfigurationChanged hooks',
		)
	if (hooks.length) {
		const position = hooks[0].index
		const depth = [...code.slice(opening, position)].reduce(
			(value, character) =>
				value + (character === '{' ? 1 : character === '}' ? -1 : 0),
			0,
		)
		const start = contents.lastIndexOf('\n', position) + 1
		const signature =
			/^[\t ]*override\s+fun\s+onConfigurationChanged\s*\(\s*newConfig\s*:\s*Configuration\s*\)\s*\{/.exec(
				code.slice(start),
			)
		if (position <= opening || position >= closing || depth !== 1 || !signature)
			throw new Error(
				'Melo font-scale generation cannot replace an unknown onConfigurationChanged hook',
			)
		const end = closingBrace(start + signature[0].lastIndexOf('{')) + 1
		if (
			contents.slice(start, end).replace(/\r\n/g, '\n').trim() !==
			fontScaleRefresh.trim()
		)
			throw new Error(
				'Melo font-scale generation found custom onConfigurationChanged behavior; preserve it and adapt explicitly',
			)
	}
	const missingImports = [...fontScaleImports]
	for (const imported of code.matchAll(/^[\t ]*import[\t ]+([^\r\n]+)/gm)) {
		const [path, alias] = imported[1]
			.trim()
			.replace(/;$/, '')
			.split(/\s+as\s+/)
		const binding = (alias || path.split('.').at(-1)).replace(/^`|`$/g, '')
		for (const expected of fontScaleImports) {
			if (path !== expected && binding !== expected.split('.').at(-1)) continue
			if (path !== expected || alias || !missingImports.includes(expected))
				throw new Error(
					`Melo font-scale generation found a conflicting import for ${binding}`,
				)
			missingImports.splice(missingImports.indexOf(expected), 1)
		}
	}
	if (
		/\b(?:class|interface|object|typealias)\s+(?:Configuration|ReactApplication|LifecycleEventListener)\b/.test(
			code,
		)
	)
		throw new Error(
			'Melo font-scale generation found a conflicting local Kotlin type',
		)
	const newline = contents.includes('\r\n') ? '\r\n' : '\n'
	if (!hooks.length)
		contents =
			contents.slice(0, opening + 1) +
			newline +
			fontScaleRefresh.replace(/\n/g, newline) +
			newline +
			contents.slice(opening + 1)
	if (missingImports.length) {
		const firstImport = /^[\t ]*import[\t ]+/m.exec(contents)
		if (!firstImport)
			throw new Error(
				'Melo font-scale generation cannot find MainActivity imports',
			)
		contents =
			contents.slice(0, firstImport.index) +
			missingImports.map((path) => `import ${path}${newline}`).join('') +
			contents.slice(firstImport.index)
	}
	return contents
}

module.exports = (config) => {
	config = withAndroidManifest(config, (mod) => {
		const app = mod.modResults.manifest.application[0]
		const activity = AndroidConfig.Manifest.getMainActivityOrThrow(
			mod.modResults,
		)
		const configChanges = (activity.$['android:configChanges'] || '')
			.split('|')
			.filter(Boolean)
		if (!configChanges.includes('fontScale'))
			activity.$['android:configChanges'] = [
				...configChanges,
				'fontScale',
			].join('|')
		app.$['android:allowBackup'] = 'false'
		app['meta-data'] = (app['meta-data'] || []).filter(
			(entry) => !entry.$['android:name'].startsWith('firebase_'),
		)
		app['meta-data'].push({
			$: {
				'android:name': 'firebase_analytics_collection_enabled',
				'android:value': 'false',
			},
		})
		return mod
	})
	config = withMainActivity(config, (mod) => {
		if (mod.modResults.language !== 'kt')
			throw new Error(
				'Melo font-scale generation requires a Kotlin MainActivity',
			)
		mod.modResults.contents = refreshFontScale(mod.modResults.contents)
		return mod
	})
	return withAppBuildGradle(config, (mod) => {
		if (
			mod.modResults.contents.includes(
				'// Internal review signing is separate from the experimental/debug key.',
			)
		)
			return mod
		mod.modResults.contents += `
// Internal review signing is separate from the experimental/debug key.
if (findProperty('meloUnsignedRelease') == 'true') {
    // CI signs the verified APK afterwards, outside Gradle and its caches.
    android.buildTypes.release.signingConfig = null
} else if (System.getenv('MELO_KEYSTORE')) {
    android.signingConfigs.create('meloInternal') {
        storeFile file(System.getenv('MELO_KEYSTORE'))
        storePassword System.getenv('MELO_KEYSTORE_PASSWORD')
        keyAlias 'melocanvas-internal'
        keyPassword System.getenv('MELO_KEYSTORE_PASSWORD')
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.meloInternal
} else if (gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }) {
    throw new GradleException('Internal builds require MELO_KEYSTORE and MELO_KEYSTORE_PASSWORD; run scripts/android-build.ps1.')
}
`
		return mod
	})
}
