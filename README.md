# PageNest

本地优先、模块化的智能文档处理工作站。PageNest 面向桌面浏览器，将文档工具组织在统一、简洁的工作区中。

**当前版本：v0.1.0 · Phase 1**

## 当前可以做什么

- 访问工作台、格式转换、文件压缩、PDF 页面管理、OCR、任务记录和设置。
- 通过选择或拖放文件查看名称、类型和大小等基础信息。
  单个文件最多 100 MiB（104,857,600 字节），最多保留 20 个文件。文件大小按 1024 进制计算；当前界面沿用 KB、MB 等标签，其中 MB 对应 MiB（1024² 字节），KB 对应 KiB（1024 字节）。
- 切换浅色、深色、跟随系统主题，并在本机保存主题偏好。
- 了解各模块的后续能力与处理方式。

本阶段仅完成工程基础和 UI。文档转换、压缩、PDF 编辑、OCR 和任务处理引擎尚未实现；相关操作会明确展示待开发状态，不会生成处理结果或模拟进度。全局文档搜索也尚未开放。

文件保留在当前浏览器会话中，应用不会将文件上传至服务器，也不会保存文件内容或文件列表。刷新或关闭页面会清除本次选择；只有主题偏好保存在浏览器本地存储中。页面本身和静态资源仍由网站托管方提供。

## 功能规划

| 模块         | 后续方向                                                            |
| ------------ | ------------------------------------------------------------------- |
| 格式转换     | PDF、Word、PowerPoint、Excel 之间的实用转换，区分视觉保真和可编辑性 |
| 文件压缩     | PPTX 严格无损优化、视觉优化，以及 PDF 多档压缩                      |
| PDF 页面管理 | 拆分、合并、删除、排序、旋转和指定页面导出                          |
| OCR 智能识别 | 扫描文档识别、关键词定位和可搜索化；可搜索不代表完全可编辑          |
| 任务与工具箱 | 批量处理、任务队列、图片与表格提取、多步骤工作流                    |

简单任务计划优先在浏览器执行；高级能力可通过可选的 Windows 本地 Python / FastAPI 引擎提供。转换质量与可编辑性取决于原始文档，不承诺所有格式均可完全无损转换。

## 技术栈

React、TypeScript、Vite、Tailwind CSS、shadcn/ui 风格基础组件、Lucide Icons、React Router、Vitest 和 React Testing Library。项目使用 Hash Router 以适配静态站点；当前不需要 Python 服务。

## 本地安装与运行

最低要求 Node.js 22.12.0（与 `package.json` 的 `engines` 一致）；推荐使用 Node.js 24 和 npm 11，与本地验收和 CI 环境保持一致。

```sh
npm ci
npm run dev
```

访问开发服务器输出的地址。Vite 的基础路径固定为 `/PageNest/`，开发地址通常为 `http://localhost:5173/PageNest/`。

```sh
# 类型检查、代码风格、自动化测试、生产构建与公开文件候选审查
npm run check

# 也可以分别执行
npm run typecheck
npm run lint
npm test
npm run build
npm run audit:files

# 本地预览生产构建
npm run preview

# 检查运行时依赖的已知漏洞（需要访问 npm registry）
npm audit --omit=dev --audit-level=moderate
```

`npm test` 以非交互方式依次运行前端测试和隔离 Git 仓库安全回归测试；也可使用 `npm run test:security` 单独运行后者。`dist/` 是本地生成目录，不应提交。

为修复构建工具链的已知 glob 复杂度漏洞，项目暂时将 `@typescript-eslint/typescript-estree` 的 `minimatch` 局部锁定为 `11.0.7`；上游发布包含修复的版本后可移除此 override，再执行完整检查与依赖审计。

## 代码组织

页面、共享 UI、导航布局、主题状态、文件状态、功能配置、类型和本地引擎接口分别组织在 `src/` 的独立模块中。新增工具应添加页面与功能配置，并接入既有路由和布局；避免在单个组件中堆叠整个工作站。引擎接口仅定义连接边界，不会在本阶段主动连接本地服务。

## 隐私与仓库审查

私人样本应放在 `local-data/`，临时文件放在 `temp/`，生成结果放在 `outputs/`，日志放在 `logs/`。这些目录以及本地代理约束、凭据、缓存、依赖和构建产物均被忽略。

`npm run audit:files` 分别检查 Git 暂存区实际 Blob 内容，以及工作目录中已追踪文件和未被忽略的新增候选文件。已经被追踪或被强制暂存的文件即使匹配忽略规则，也会接受检查。发现禁传路径、可疑凭据或非预期二进制文件时返回失败；报告仅包含文件路径、扫描来源和问题类别，不打印命中的敏感值。它是启发式辅助审查，不能证明文件绝无私人信息；上传前仍需人工审核实际暂存区 diff。

人工生成的文档测试样本仅允许在 `tests/fixtures/synthetic/`、`test/fixtures/synthetic/` 或 `src/test/fixtures/synthetic/` 中，经人工确认无隐私后再考虑提交。真实文档和 OCR 输出不得进入仓库。

提交前逐项检查：

```sh
git status
git diff
git diff --cached
git diff --cached --check
git ls-files
git check-ignore -v AGENTS.md
npm run audit:files
```

忽略规则无法保护已追踪文件。只应按审核通过的具体路径暂存，不应无差别暂存整个目录，不得强制添加被忽略文件。未经明确批准，不执行远程推送、PR、Release、仓库设置修改或发布。

## GitHub Pages 部署

目标站点：[PageNest](https://ZZH-0427.github.io/PageNest/)。配置说明不表示站点已经发布。

- `vite.config.ts` 使用 `base: '/PageNest/'`；Hash Router 形成 `/PageNest/#/...` 路由，刷新工具页面时无需服务端回退配置。
- `checks.yml` 对目标为 `main` 的 Pull Request 执行类型检查、lint、测试、候选文件审查、生产依赖审计和构建。
- `deploy.yml` 在代码进入 `main` 后复用同一套检查；全部通过才上传 `dist/` 并部署 Pages。构建产物由 Actions 生成，不提交到 Git。
- 检查任务仅有 `contents: read`；仅部署任务具有 `pages: write` 和 `id-token: write`。

首次上线需要仓库管理员在审核并批准之后，将 Settings → Pages → Source 设为 GitHub Actions。建议保护 `main`、要求 PR 审核和 Checks 成功；如需每次上线再确认，可为 `github-pages` 环境配置审核人。工作流本身不能替代分支保护和人工审核，项目初始化不会修改这些远程设置。

GitHub Pages 仅托管静态前端，无法运行 Python / FastAPI 服务。本阶段仅准备部署配置，不主动推送或触发发布。
