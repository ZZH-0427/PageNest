import {
  ArrowLeftRight,
  FileArchive,
  Files,
  ScanText,
  LayoutDashboard,
  ListTodo,
  Settings2,
} from "lucide-react";

export const tools = [
  {
    id: "converter",
    name: "格式转换",
    english: "Converter",
    icon: ArrowLeftRight,
    color: "blue",
    description: "在 PDF 与 Office 文档之间，自由转换。",
    detail:
      "为不同场景选择更合适的文档格式。未来可选择优先保留视觉效果或内容可编辑性。",
    formats: [
      "Word → PDF",
      "PDF → Word",
      "PPT → PDF",
      "Excel → PDF",
      "PDF → PPT",
      "PDF → Excel",
    ],
    future: "转换无法保证完全无损；复杂排版可能需要人工检查。",
  },
  {
    id: "compression",
    name: "文件压缩",
    english: "Compression",
    icon: FileArchive,
    color: "orange",
    description: "更小的文件体积，同样出色的呈现。",
    detail:
      "为 PDF 和 PPTX 选择适合的压缩方式。严格无损与视觉优化将分别提供，保留清晰的质量边界。",
    formats: [
      "PDF 结构优化",
      "PDF 高质量压缩",
      "PDF 均衡压缩",
      "PDF 高压缩率",
      "PPTX 严格无损",
      "PPTX 视觉优化",
    ],
    future: "压缩引擎尚未接入，当前不会改动文件或预估压缩率。",
  },
  {
    id: "pdf-editor",
    name: "PDF 页面管理",
    english: "PDF Editor",
    icon: Files,
    color: "purple",
    description: "导入 PDF，浏览真实页面与文档信息。",
    detail:
      "在浏览器本地解析 PDF，按需预览缩略图、页面尺寸与方向。",
    formats: [
      "合并 PDF",
      "拆分 PDF",
      "删除页面",
      "页面重排",
      "旋转页面",
      "选择页面导出",
    ],
    future: "已支持本地导入与预览；合并、拆分、删除、排序、旋转和导出尚未开放。",
  },
  {
    id: "ocr",
    name: "智能文字识别",
    english: "OCR",
    icon: ScanText,
    color: "green",
    description: "从扫描件与图片中，发现可搜索的文字。",
    detail:
      "让扫描 PDF 与图片型幻灯片拥有文字索引，逐步支持关键词定位与可搜索文档导出。",
    formats: [
      "扫描 PDF 识别",
      "图片 PPT 识别",
      "全文搜索",
      "关键词定位",
      "可搜索 PDF",
      "PPTX 搜索兼容",
    ],
    future: "可搜索化不等于完全可编辑化；OCR 准确率取决于源文件质量。",
  },
] as const;

export const navigation = [
  { id: "", name: "工作台", english: "Dashboard", icon: LayoutDashboard },
  ...tools,
  { id: "tasks", name: "任务记录", english: "Tasks", icon: ListTodo },
  { id: "settings", name: "设置", english: "Settings", icon: Settings2 },
];
