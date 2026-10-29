# 无旧历史的公开源码快照

私有开发仓库继续保留原历史。公开候选从已提交源码按 `release/public-source-files.json` 的逐文件白名单导出，不复制开发目录或 `.git`，不使用旧分支 / 标签，也不读取未提交和忽略文件。

```sh
node scripts/export-public-snapshot.cjs /absolute/path/to/new-directory HEAD
```

目标必须不存在。导出拒绝路径穿越、符号链接、子模块、缺失文件及敏感信息检查命中；保存 `SOURCE_SNAPSHOT.json`，记录每个文件 SHA-256、模式和整体内容标识，不带作者、邮箱、远程地址、旧 commit 信息。无 Git 目录的元数据构建优先使用此标识，避免误读父目录私有库。

该快照状态为 `LOCAL_REVIEW_ONLY`，不表示已获准发布。发布前按 [候选状态](public-beta-status.md) 关闭剩余阻断，复核白名单、素材和源码文件。新增文件不会自动加入白名单；更新时必须逐项审查，不要将 `git ls-files` 的全部输出无条件作为公开集合。

维护者已指定公开目标为 [MeloCanvas-Public](https://github.com/lxiaodong681-lab/MeloCanvas-Public)。审查通过后，在快照目录用明确的公开署名 / noreply 邮箱初始化独立 Git 仓库，创建单个根提交；不得推送旧开发分支或镜像验证历史。导出工具本身只导出文件，不初始化远程仓库、推送、改可见性或创建 Release。原私有仓库及旧 PR 不得作为公开下载 / 反馈链接或 fork 来源。

本地依赖安装、测试和构建产生的文件不属于快照，不可连同 node_modules、缓存、日志、密钥或 APK 一起重新打包。源码 ZIP 仅从导出清单和快照清单组成；另附 LGPL 源码材料包。最终包 SHA-256 和签名验收结果在放行时另行绑定。
