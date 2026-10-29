# 发布记录

## 版本 0.1.0

- 分发方式：**只走 GitHub**，没有发布到 npm
- 安装：`dsh plugin --profile <p> add github:wodexiaoling/dsh-plugin-memory-four-books`
- 包内容：11 个文件 / 20.6 KB，零数据

## 发布前做过什么

- 包名占用检查：`dsh-plugin-memory-four-books` 在 npm 上无人占用（保留以后想发时的余地）
- `npm pack --dry-run` 内容核对：只有源码、文档、图标
- 解包冒烟：全新目录首启为空状态（五区全 0），四个工具注册成功，记录 → 归纳 → 召回全链路通过
- `install_bundle` 实测：能装、能激活、无 warnings
- 同一 profile 装两份会因 patch id 相同冲突（`unaddressable`），这是预期——同一插件只能装一份

## 以后要更新版本

1. 改 `package.json` 的 `version`
2. `git commit` + `git push`
3. 用户侧：`dsh plugin remove` 再 `add`，或等 dsh 支持更新

## 以后想发 npm（可选）

```powershell
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
```
