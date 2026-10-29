const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
// Keep JS bundling within the serial resource budget used by native builds.
config.maxWorkers = 1

module.exports = config
