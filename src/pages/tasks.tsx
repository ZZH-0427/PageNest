import { ListTodo, ArrowRight, CircleDashed } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";

export function Tasks() {
  return (
    <div className="page">
      <div className="page-title">
        <div className="eyebrow">A LITTLE MORE ORGANIZED</div>
        <div className="title-line">
          <h1>任务记录</h1>
          <span className="soon-badge large">即将推出</span>
        </div>
        <p>
          每一次处理，都有迹可循。未来在这里管理任务队列、查看进度与导出结果。
        </p>
      </div>
      <div className="task-summary">
        <div>
          <span>全部任务</span>
          <strong>0</strong>
        </div>
        <div>
          <span>处理中</span>
          <strong>0</strong>
        </div>
        <div>
          <span>已完成</span>
          <strong>0</strong>
        </div>
        <div>
          <span>等待处理</span>
          <strong>0</strong>
        </div>
      </div>
      <section className="empty-panel">
        <span className="empty-icon">
          <ListTodo size={35} strokeWidth={1.3} />
        </span>
        <h2>这里，等待你的第一个任务。</h2>
        <p>
          文档处理引擎尚未开放，因此还没有任务记录。
          <br />
          选择文件只会读取基本信息，不会创建处理任务。
        </p>
        <Button asChild variant="outline">
          <Link to="/">
            返回工作台
            <ArrowRight size={15} />
          </Link>
        </Button>
        <span className="empty-footnote">
          <CircleDashed size={13} />
          任务历史与批量处理将在后续版本提供
        </span>
      </section>
    </div>
  );
}
