# 个人创意主页 - 技术说明文档

本项目是一个现代化的个人主页系统，采用 3 级页面架构，旨在展示个人的技术见解、兴趣爱好及专业作品。

## 项目特点

1.  **现代化视觉设计**：采用流行的 "Glassmorphism" (毛玻璃) 风格，结合动态渐变背景和丝滑的微动画，提供极佳的视觉体验。
2.  **3 级导航结构**：
    *   **Level 1**: 首页 (`index.html`) - 整体概览。
    *   **Level 2**: 列表页 (`hobbies.html`, `portfolio.html`, `contact.html`) - 分类展示。
    *   **Level 3**: 详情页 (`hobby-detail.html`, `work-detail.html`) - 深度内容。
3.  **自定义交互系统**：弃用原生 `alert`，开发了基于 Vanilla JS 的 Toast 通知系统，用于表单验证反馈和交互提示。
4.  **纯净技术栈**：仅使用 HTML5, CSS3 和原生 JavaScript，无需任何外部框架。

## 文件结构

- `index.html`: 入口首页
- `hobbies.html`: 兴趣爱好列表 (L2)
- `hobby-detail.html`: 摄影兴趣详情 (L3)
- `portfolio.html`: 作品集列表 (L2)
- `work-detail.html`: Neo-Finance 应用案例 (L3)
- `contact.html`: 联系表单页 (L2)
- `css/style.css`: 全局样式表
- `js/main.js`: 交互逻辑与表单验证
- `images/`: 项目多媒体资源

## 技术要点

- **CSS 选择器**：广泛使用伪类 (`:hover`, `:focus`), 子选择器及复杂层叠关系。
- **盒模型布局**：利用 Flexbox 和 CSS Grid 实现响应式布局。
- **表单验证**：实时检测用户输入，并通过自定义 UI 组件进行错误提示。

---

## 志愿服务地图（新增）

为个人站新增的志愿服务经历地图，包含**脱敏发布管线**，不止于前端移图钉：

- **公开页** [`volunteer.html`](volunteer.html)：地图/列表切换、年份筛选与分享链接、统计与地图读取**同一份发布快照**；瓦片服务失效时降级为 SVG 示意图。
- **管理页** [`admin.html`](admin.html)：录入服务事件、机构更名/搬迁（按有效期）、公开授权与撤销、照片上传（服务端剥离 EXIF/GPS）、粒度策略、发布与审计。
- **服务** `server/`（零依赖 Node）：`npm start` 启动（可用 `ADMIN_TOKEN`、`PORT` 环境变量）；`npm test` 运行 23 项验收测试。
- 数据三域分离：原始定位 / 城市范围 / 机构公开信息；公开接口只查询脱敏快照（城市质心、模糊网格或机构授权点）。
- 设计与粒度取舍（城市质心 vs 行政面 vs 模糊网格）、隐私边界与验收映射见 [`server/PRIVACY_DESIGN.md`](server/PRIVACY_DESIGN.md)。
