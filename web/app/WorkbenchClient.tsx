"use client";
import dynamic from "next/dynamic";

// 工作台全在浏览器里跑（pdf.js、CodeMirror、令牌都在浏览器端），不做服务端渲染
const Workbench = dynamic(() => import("@/client/Workbench").then((module) => module.Workbench), { ssr: false });

export function WorkbenchClient() {
  return <Workbench />;
}
