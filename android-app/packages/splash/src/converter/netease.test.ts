import * as fs from 'fs'
import * as path from 'path'

import { parseSpl } from '../parser'

import { parseYrc, formatSplTime } from './netease'

describe('网易云 YRC 转换器', () => {
	it('应该正确格式化时间', () => {
		expect(formatSplTime(0)).toBe('00:00.000')
		expect(formatSplTime(1000)).toBe('00:01.000')
		expect(formatSplTime(60000)).toBe('01:00.000')
		expect(formatSplTime(61234)).toBe('01:01.234')
	})

	it('应该解析 JSON 格式的元数据行', () => {
		const input = `{"t":0,"c":[{"tx":"制作人: "},{"tx":"示例制作人"}]}\n{"t":1000,"c":[{"tx":"作词: "},{"tx":"示例作词人"}]}`
		const output = parseYrc(input)
		expect(output).toBe('[00:00.000]制作人: 示例制作人\n[00:01.000]作词: 示例作词人')
	})

	it('应该解析简单的 YRC 行', () => {
		// [57500,3500](57500,520,0)示(58020,180,0)例...
		const input = `[57500,3500](57500,520,0)示(58020,180,0)例`
		const output = parseYrc(input)
		// 57500 = 57.500
		// 58020 = 58.020
		// Word 2 End: 58020 + 180 = 58200 = 00:58.200
		expect(output).toBe('[00:57.500]示<00:58.020>例<00:58.200>')
	})

	it('应该处理延迟开始的情况', () => {
		// Line starts at 1000. Word 1 starts at 1500.
		// Word 1: 1500, 500 -> End 2000
		// Word 2: 2000, 500 -> End 2500
		const input = `[1000,2000](1500,500,0)Hello(2000,500,0)World`
		const output = parseYrc(input)
		// [00:01.000] Line start
		// <00:01.000> First gap start (implicit from line start)
		// <00:01.500> Word 1 start
		// <00:02.000> Word 1 end / Word 2 start (contiguous)
		// <00:02.500> Word 2 end
		expect(output).toBe(
			'[00:01.000]<00:01.000><00:01.500>Hello<00:02.000>World<00:02.500>',
		)
	})

	it('应该解析随源码分发的合成文件数据', () => {
		const filePath = path.join(__dirname, '../__tests__/fixtures/synthetic-yrc.json')
		const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { yrc: { lyric: string } }
		expect(parseYrc(data.yrc.lyric)).toBe('[00:57.500]示<00:58.020>例<00:58.200>')
	})
	it('应该解析混合了 JSON 和标准 LRC 的行', () => {
		const input = `{"t":0,"c":[{"tx":"作词: "},{"tx":"示例作者"}]}
{"t":1000,"c":[{"tx":"作曲: "},{"tx":"示例作者"}]}
[00:20.848]合成测试第1行
[00:25.915]合成测试第2行`

		const output = parseYrc(input)
		const lines = output.split('\n')

		expect(lines).toContain('[00:00.000]作词: 示例作者')
		expect(lines).toContain('[00:01.000]作曲: 示例作者')
		expect(lines).toContain('[00:20.848]合成测试第1行')
		expect(lines).toContain('[00:25.915]合成测试第2行')
	})

	it('应该规范化合成冒号百分秒 LRC', () => {
		// Synthetic text retains the colon-centisecond timing regression.
		const input = `[00:00.00] 作词 : 示例作者
[00:01.00] 作曲 : 示例作者
[00:22:25]合成测试第4行
[00:28:96]合成测试第5行`

		const output = parseYrc(input)
		expect(output).toBe(`[00:00.00] 作词 : 示例作者
[00:01.00] 作曲 : 示例作者
[00:22.25]合成测试第4行
[00:28.96]合成测试第5行`)

		const parsed = parseSpl(output)
		expect(parsed.lines).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					startTime: 22250,
					content: '合成测试第4行',
				}),
				expect.objectContaining({
					startTime: 28960,
					content: '合成测试第5行',
				}),
			]),
		)
	})

	it('应该正确处理过长的间奏（遵循词的持续时间）', () => {
		// [57920,11880](57920,830,0)甲... (64080,2630,0)乙
		// Line end: 57920 + 11880 = 69800 = 01:09.800
		// Last word end: 64080 + 2630 = 66710 = 01:06.710
		const input = `[57920,11880](57920,830,0)甲(64080,2630,0)乙`
		const output = parseYrc(input)
		// Should end at 01:06.710, not 01:09.800
		// Should include gap: <00:58.750> (end of 甲) -> <01:04.080> (start of 乙)
		expect(output).toBe('[00:57.920]甲<00:58.750><01:04.080>乙<01:06.710>')
	})

	it('应该优雅地处理负时间戳', () => {
		const input = `{"t":-1,"c":[{"tx":"Invalid Time"}]}`
		const output = parseYrc(input)
		// Should clamp to 00:00.000
		expect(output).toBe('[00:00.000]Invalid Time')
	})
})
