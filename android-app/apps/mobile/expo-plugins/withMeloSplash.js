const { withAndroidStyles, withDangerousMod } = require('expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

function writeSplash(projectRoot, androidRoot) {
	const res = path.join(androidRoot, 'app/src/main/res')
	fs.mkdirSync(path.join(res, 'values-night'), { recursive: true })
	fs.writeFileSync(path.join(res, 'values-night/melo_appearance.xml'), '<resources>\n  <color name="splashscreen_background">#000000</color>\n</resources>\n')
	fs.mkdirSync(path.join(res, 'drawable-nodpi'), { recursive: true })
	fs.copyFileSync(path.join(projectRoot, 'melo/assets/icon.png'), path.join(res, 'drawable-nodpi/melo_splash_logo.png'))
	fs.mkdirSync(path.join(res, 'drawable'), { recursive: true })
	fs.writeFileSync(path.join(res, 'drawable/melo_splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:drawable="@color/splashscreen_background" />
  <item android:width="96dp" android:height="96dp" android:gravity="center">
    <bitmap android:src="@drawable/melo_splash_logo" android:gravity="fill" />
  </item>
</layer-list>
`)
	fs.mkdirSync(path.join(res, 'values-v31'), { recursive: true })
	fs.writeFileSync(path.join(res, 'values-v31/melo_splash.xml'), `<resources>
  <style name="Theme.App.SplashScreen" parent="AppTheme">
    <item name="android:windowBackground">@drawable/melo_splash</item>
    <item name="android:windowSplashScreenBackground">@color/splashscreen_background</item>
    <item name="android:windowSplashScreenAnimatedIcon">@drawable/melo_splash_logo</item>
  </style>
</resources>
`)
}
module.exports = function withMeloSplash(config) {
	config = withAndroidStyles(config, (mod) => {
		const splash = mod.modResults.resources.style.find((style) => style.$.name === 'Theme.App.SplashScreen')
		if (!splash) throw new Error('Missing Android splash theme')
		splash.item = (splash.item || []).filter((item) => item.$.name !== 'android:windowBackground')
		splash.item.push({ $: { name: 'android:windowBackground' }, _: '@drawable/melo_splash' })
		return mod
	})
	return withDangerousMod(config, ['android', async (mod) => {
		writeSplash(mod.modRequest.projectRoot, mod.modRequest.platformProjectRoot)
		return mod
	}])
}
module.exports.writeSplash = writeSplash
