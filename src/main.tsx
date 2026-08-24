import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { startPerfObserver } from './services/perf';

// 性能遥测：只记录超阈值事件（长任务等），用于定位真实卡顿点
startPerfObserver();

// 不使用 StrictMode：它仅在开发模式生效，但会把所有组件渲染与 effect
// 执行翻倍（包括 CodeMirror 初始化、笔记加载），拖慢 dev 体验
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
