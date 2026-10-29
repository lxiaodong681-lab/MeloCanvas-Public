const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')

const withMeloAndroid = require('./withMeloAndroid')

const imports = [
	'android.content.res.Configuration',
	'com.facebook.react.ReactApplication',
	'com.facebook.react.bridge.LifecycleEventListener',
]
const refresh = `  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // RN refreshes its cached font scale on resume; an active config change
    // also needs that existing DeviceInfo refresh so JS can remeasure text.
    val context = (application as ReactApplication).reactHost?.currentReactContext
    val deviceInfo = context?.getNativeModule("DeviceInfo")
    if (deviceInfo is LifecycleEventListener) deviceInfo.onHostResume()
  }`
const template = `package org.melocanvas.app

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Keep the template's application setup.
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"

  // Braces and hook names inside comments/strings are not Kotlin declarations.
  // fun onConfigurationChanged(value: Any) { preserve this comment }
  private val preserved = "onConfigurationChanged { leave this text alone }"
}
`
function configured() {
	return withMeloAndroid({ name: 'MeloCanvas', slug: 'melocanvas' })
}
async function activity(contents, language = 'kt') {
	const config = configured()
	const callback = config.mods?.android?.mainActivity
	assert.equal(
		typeof callback,
		'function',
		'Expo must register a mainActivity mod',
	)
	const mod = {
		...config,
		modResults: { contents, language },
		modRequest: { platform: 'android', modName: 'mainActivity' },
	}
	try {
		const result = await callback(mod)
		return result.modResults.contents
	} catch (error) {
		assert.equal(
			mod.modResults.contents,
			contents,
			'a rejected input stays untouched',
		)
		throw error
	}
}
const occurrences = (source, value) => source.split(value).length - 1

void test('clean Kotlin template gains the existing DeviceInfo refresh without rewriting other code', async () => {
	const result = await activity(template)
	assert.ok(result.includes(refresh))
	for (const name of imports)
		assert.equal(occurrences(result, `import ${name}\n`), 1)
	let stripped = result.replace(`\n${refresh}\n`, '')
	for (const name of imports)
		stripped = stripped.replace(`import ${name}\n`, '')
	assert.equal(stripped, template)
})

void test('actual already-fixed MainActivity is byte-for-byte unchanged', async () => {
	const current = readFileSync(
		join(
			__dirname,
			'../android/app/src/main/java/org/melocanvas/app/MainActivity.kt',
		),
		'utf8',
	)
	assert.ok(current.replaceAll('\r\n', '\n').includes(refresh))
	assert.equal(await activity(current), current)
})

void test('repeated generation and CRLF templates stay idempotent without duplicate hooks or imports', async () => {
	for (const input of [template, template.replaceAll('\n', '\r\n')]) {
		const once = await activity(input)
		assert.equal(await activity(once), once)
		assert.equal(await activity(await activity(once)), once)
		assert.equal(occurrences(once, 'override fun onConfigurationChanged('), 1)
		for (const name of imports)
			assert.equal(occurrences(once, `import ${name}`), 1)
		if (input.includes('\r\n'))
			assert.equal(once.replaceAll('\r\n', '').includes('\n'), false)
	}
})

void test('known refresh with missing imports repairs only imports', async () => {
	const input = template.replace(
		'class MainActivity : ReactActivity() {',
		`class MainActivity : ReactActivity() {\n${refresh}\n`,
	)
	const result = await activity(input)
	let stripped = result
	for (const name of imports)
		stripped = stripped.replace(`import ${name}\n`, '')
	assert.equal(stripped, input)
	assert.equal(await activity(result), result)
})

void test('unknown existing hooks and duplicate hooks reject instead of dropping custom behavior', async () => {
	const custom = `  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    customConfigurationChanged(newConfig)
  }`
	for (const body of [
		custom,
		`${refresh}\n${refresh}`,
		refresh.replace('"DeviceInfo"', '"OtherModule"'),
	]) {
		const input = template.replace(
			'class MainActivity : ReactActivity() {',
			`class MainActivity : ReactActivity() {\n${body}\n`,
		)
		await assert.rejects(activity(input), /onConfigurationChanged|font.scale/i)
	}
})

void test('conflicting import bindings and partial refreshes reject with the original source retained', async () => {
	const conflicts = [
		'import example.Configuration',
		'import example.NativeInfo as LifecycleEventListener',
		'import com.facebook.react.ReactApplication as DifferentApplication',
		'import android.content.res.Configuration\nimport android.content.res.Configuration',
	]
	for (const imported of conflicts) {
		await assert.rejects(
			activity(
				template.replace(
					'import android.os.Bundle',
					`${imported}\nimport android.os.Bundle`,
				),
			),
			/import|font.scale|Configuration|ReactApplication|LifecycleEventListener/i,
		)
	}
	await assert.rejects(
		activity(
			template.replace(
				'class MainActivity : ReactActivity() {',
				`class MainActivity : ReactActivity() {\n${refresh.replace('    super.onConfigurationChanged(newConfig)\n', '')}\n`,
			),
		),
		/onConfigurationChanged|font.scale/i,
	)
})

void test('unsupported language or ambiguous MainActivity structure fails explicitly', async () => {
	await assert.rejects(
		activity('public class MainActivity extends ReactActivity {}', 'java'),
		/Kotlin|language/i,
	)
	await assert.rejects(
		activity(template.replace('class MainActivity', 'class OtherActivity')),
		/MainActivity/i,
	)
	await assert.rejects(
		activity(template + '\nclass MainActivity : ReactActivity() {}\n'),
		/MainActivity/i,
	)
	await assert.rejects(
		activity(template.replace('package org.melocanvas.app\n', '')),
		/package|MainActivity/i,
	)
})

void test('the real Expo config mod chain retains manifest fontScale and existing Gradle signing setup', async () => {
	const config = configured()
	const entry = {
		$: {
			'android:name': '.MainActivity',
			'android:configChanges': 'orientation|screenSize',
		},
		'intent-filter': [
			{
				action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
				category: [
					{ $: { 'android:name': 'android.intent.category.LAUNCHER' } },
				],
			},
		],
	}
	const application = { $: {}, activity: [entry], 'meta-data': [] }
	const modResults = { manifest: { application: [application] } }
	const manifest = {
		...config,
		modResults,
		modRequest: { platform: 'android', modName: 'manifest' },
	}
	await config.mods.android.manifest(manifest)
	await config.mods.android.manifest(manifest)
	assert.equal(
		entry.$['android:configChanges'],
		'orientation|screenSize|fontScale',
	)
	assert.equal(application.$['android:allowBackup'], 'false')
	assert.equal(application['meta-data'].length, 1)
	const input = 'android { /* existing build configuration */ }\n'
	const build = {
		...config,
		modResults: { language: 'groovy', contents: input },
		modRequest: { platform: 'android', modName: 'appBuildGradle' },
	}
	await config.mods.android.appBuildGradle(build)
	const once = build.modResults.contents
	await config.mods.android.appBuildGradle(build)
	assert.equal(build.modResults.contents, once)
	assert.ok(once.startsWith(input))
	assert.equal(
		occurrences(
			once,
			'// Internal review signing is separate from the experimental/debug key.',
		),
		1,
	)
	assert.ok(
		once.includes(
			'android.buildTypes.release.signingConfig = android.signingConfigs.meloInternal',
		),
	)
})
