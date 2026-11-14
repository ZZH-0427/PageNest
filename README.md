# PageNest

本地优先、模块化的智能文档处理工作站。PageNest 面向桌面浏览器，将文档工具组织在统一、简洁的工作区中。

**当前本地版本：v0.2.0 · Phase 2B-1**

## 当前可以做什么

- 访问工作台、格式转换、文件压缩、PDF 页面管理、OCR、任务记录和设置。
- 工作台及通用工具页面支持选择或拖放文件，查看名称、类型和大小等基础信息，不读取文档内容。
- 在 PDF 页面管理中独立导入一个或多个真实 PDF，解析实际页数，浏览按需渲染的页面缩略图，并查看页面尺寸与方向。
- 切换 PDF、选择页面、移除文件或清空 PDF 工作区。同名文件分别保留，批量导入中单个文件失败不会阻止其他文件。
- 在单份 PDF 内多选、删除、调整页面顺序和旋转页面，并分别撤销或重做每份文档的编辑。
- 切换浅色、深色、跟随系统主题，并在本机保存主题偏好。

单个文件最多 100 MiB（104,857,600 字节），最多保留 20 个文件。PDF 工作区另有累计 256 MiB、每份 PDF 最多 1,000 页的限制，以控制浏览器内存占用。容量按 1024 进制计算；通用文件列表沿用 KB、MB 标签，其中 MB 对应 MiB（1024² 字节），KB 对应 KiB（1024 字节）。

Phase 2B-1 提供内存中的页面编辑，尚未生成新的 PDF 文件。合并、拆分和导出入口保持禁用，后续阶段再开放；移除文件只会将整份 PDF 移出当前工作区。文档转换、压缩、OCR、任务处理和全局搜索也尚未开放，不会生成虚假的处理结果。

PDF 原始数据只在当前 PDF 工作区的浏览器内存中用于解析与渲染，离开 PDF 页面、刷新或关闭页面时清除。工作台和其他通用工具继续只保存文件元数据，其列表在刷新或关闭页面后清除，不会自动传递为已解析 PDF。应用不上传文档，不将文件内容或文件列表写入 localStorage 或 IndexedDB；只有主题偏好保存在本地。页面、Worker、字体等静态资源仍由网站托管方提供。

## PDF 工作区

从左侧导航打开 PDF 页面管理，点击添加 PDF 或拖入文件。左栏管理文件，中间浏览真实缩略图，右栏显示所选文档及页面信息。缩略图通过页面可见性检测按需加载，限制渲染并发与 Canvas 像素尺寸，避免一次渲染全部页面。文件切换会取消不再需要的缩略图任务；移除文件、清空工作区及离开页面会释放对应解析任务、文档资源与 Canvas。

单击选择一页；Ctrl / Command + 单击添加或取消选择，Shift + 单击选择连续范围。在页面网格内按 Ctrl / Command + A 全选，Esc 取消选择。删除及旋转可以批量执行，至少保留一页。鼠标拖拽仅支持单页排序，多选时禁用拖拽；也可对单页使用“向前移动一页”和“向后移动一页”按钮。页面编号代表当前顺序，检查器同时保留原始来源页码。

撤销使用 Ctrl / Command + Z；重做使用 Ctrl + Y 或 Ctrl / Command + Shift + Z。编辑快捷键只作用于 PDF 页面网格及相关编辑控件，不接管输入框或其他页面。每份文档独立保存最多 50 步编辑历史，批量操作算作一步；撤销后执行新编辑会清除重做分支。切换文件保留各自的选择和历史。

编辑模型只保存页面来源、顺序、旋转与选择信息，不修改原始 PDF，也不为每次撤销复制二进制数据。旋转会叠加 PDF 原有旋转属性，排序不会重新解析文件。当前修改仅保存在浏览器工作区，尚未生成新的 PDF 文件；移除文件、清空工作区、离开 PDF 页面或刷新会丢弃编辑及历史。

导入会检查文件特征，并由 PDF.js 真实解析。空文件、伪装 PDF、损坏文件、超限文件及解析或渲染失败都会显示明确提示。需要密码的 PDF 暂不支持；对于超出当前浏览器处理能力的文档，应使用更小的文件。复杂文档的字体、色彩和特殊 PDF 特性可能受浏览器及 PDF.js 支持程度影响。

## 功能规划

| 模块         | 后续方向                                                            |
| ------------ | ------------------------------------------------------------------- |
| 格式转换     | PDF、Word、PowerPoint、Excel 之间的实用转换，区分视觉保真和可编辑性 |
| 文件压缩     | PPTX 严格无损优化、视觉优化，以及 PDF 多档压缩                      |
| PDF 页面管理 | 拆分、合并、生成及导出编辑后的 PDF                                  |
| OCR 智能识别 | 扫描文档识别、关键词定位和可搜索化；可搜索不代表完全可编辑          |
| 任务与工具箱 | 批量处理、任务队列、图片与表格提取、多步骤工作流                    |

简单任务计划优先在浏览器执行；高级能力可通过可选的 Windows 本地 Python / FastAPI 引擎提供。转换质量与可编辑性取决于原始文档，不承诺所有格式均可完全无损转换。

## 技术栈

React、TypeScript、Vite、Tailwind CSS、shadcn/ui 风格基础组件、Lucide Icons、React Router、Vitest 和 React Testing Library。项目使用 Hash Router 以适配静态站点；当前不需要 Python 服务。

PDF 解析和渲染使用固定版本的 Mozilla [`pdfjs-dist` 6.5.438](https://github.com/mozilla/pdf.js/releases/tag/v6.5.438)（Apache-2.0），主模块和解析 Worker 均使用同一依赖中的 `legacy` 兼容构建。`legacy` 表示转译及兼容支持，不是旧版 PDF.js；支持范围以 [PDF.js 官方说明](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions)为准。

Worker 通过 Vite `?url` 资产导入生成本地构建地址。CMaps、标准字体、WASM 和 ICC 资源从同版本依赖提供，保留相应许可证，开发服务器与生产构建使用同源版本目录。不依赖 CDN，也不关闭解析 Worker 来绕过加载问题。文档二进制数据直接交给 Worker，不通过网络 URL 加载用户文档。

## 本地安装与运行

最低要求 Node.js 22.13.0（与 PDF.js 及 `package.json` 的 `engines` 一致）；推荐使用 Node.js 24 和 npm 11，与本地验收和 CI 环境保持一致。

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
npm run test:pdf-engine
npm run build
npm run audit:files

# 本地预览生产构建
npm run preview

# 检查运行时依赖的已知漏洞（需要访问 npm registry）
npm audit --omit=dev --audit-level=moderate
```

`npm test` 以非交互方式运行前端测试、真实 PDF 引擎测试和隔离 Git 仓库安全回归测试。`npm run test:pdf-engine` 使用人工生成、无私人内容的 PDF 验证 PDF.js 的真实解析和页面渲染，不只检查模拟页数；`npm run test:security` 可单独运行安全回归测试。`dist/` 是本地生成目录，不应提交。

浏览器验收应分别运行开发服务器和 `npm run build` 后的 `npm run preview`，访问 `/PageNest/#/pdf-editor`，核对真实 PDF 导入、多选、删除、拖拽排序、旋转、撤销重做、多文件切换、横纵与原始旋转页面、懒加载、移除、异常提示及主题。生产预览还应检查 Worker、JS、CSS 和 PDF.js 辅助资源均从 `/PageNest/` 下加载，深链接刷新正常且没有文档上传请求。

为修复构建工具链的已知 glob 复杂度漏洞，项目暂时将 `@typescript-eslint/typescript-estree` 的 `minimatch` 局部锁定为 `11.0.7`；上游发布包含修复的版本后可移除此 override，再执行完整检查与依赖审计。

## 代码组织

页面、共享 UI、导航布局、主题状态、文件状态、功能配置、类型和本地引擎接口分别组织在 `src/` 的独立模块中。PDF 工作区独立管理二进制数据、解析任务和渲染资源，不扩展原有全局元数据状态的职责。新增工具应添加页面与功能配置，并接入既有路由和布局；避免在单个组件中堆叠整个工作站。本地引擎接口仅定义连接边界，不会在本阶段主动连接本地服务。

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

正式站点：[PageNest](https://ZZH-0427.github.io/PageNest/)。本地版本的更新不代表已经发布到正式站点。

- `vite.config.ts` 使用 `base: '/PageNest/'`；Hash Router 形成 `/PageNest/#/...` 路由，刷新工具页面时无需服务端回退配置。
- PDF.js Worker 和辅助资源随生产构建提供，路径包含该子目录，无需第三方 CDN 或后端服务。
- `checks.yml` 对目标为 `main` 的 Pull Request 执行类型检查、lint、测试、候选文件审查、生产依赖审计和构建。
- `deploy.yml` 在代码进入 `main` 后复用同一套检查；全部通过才上传 `dist/` 并部署 Pages。构建产物由 Actions 生成，不提交到 Git。
- 检查任务仅有 `contents: read`；仅部署任务具有 `pages: write` 和 `id-token: write`。

Pages 发布来源应设为 Settings → Pages → Source → GitHub Actions。建议保护 `main`、要求 PR 审核和 Checks 成功；如需每次上线再确认，可为 `github-pages` 环境配置审核人。工作流本身不能替代分支保护和人工审核，调整这些远程设置需要另行授权。

GitHub Pages 仅托管静态前端，无法运行 Python / FastAPI 服务。Phase 2B-1 只在本地开发与验证，源码和 UI 审核通过并取得明确授权之后，才能暂存、提交、推送或发布。
